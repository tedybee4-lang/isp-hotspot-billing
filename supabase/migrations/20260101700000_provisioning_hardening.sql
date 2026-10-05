-- =============================================================================
--  Pre-hardware hardening: the schema gaps that would have blocked the first
--  real router.
--
--  Additive only. No data is rewritten, no table dropped, no PayHero table
--  touched.
--
--  1. THE RADIUS SHARED SECRET
--  ---------------------------
--  Traced before writing this, and there is no authoritative database source for
--  the secret today:
--
--    * `radius_nas` has a `secret_set` BOOLEAN. It records THAT a secret exists.
--      It is not the secret.
--    * The secret itself lives hand-pasted in deploy/freeradius/clients.conf,
--      which tells the operator to "give every router its own secret, never one
--      shared secret for all routers".
--
--  So provisioning had nowhere to read a secret from and sent none. A router
--  with an empty RADIUS secret silently rejects every Access-Request, while the
--  run reports SUCCESS because the router accepted the `/radius add` call.
--  That is the worst shape a failure can have: subscribers cannot log in and
--  the panel says the router is healthy.
--
--  This is the smallest mechanism consistent with how the platform already
--  stores credentials: the same AES-256-GCM envelope, the same
--  ROUTER_CREDENTIALS_KEY, the same service-role-only rule as
--  `router_credentials`. No second secret system, no hardcoded default.
--
--  The column is service-role only. `radius_nas` DOES have a tenant read policy
--  (the panel lists registered routers), so unlike `router_credentials` a bare
--  RLS exclusion is not enough - the column-level grants below are what actually
--  keep it out of a browser response.
-- =============================================================================

begin;

alter table public.radius_nas
  add column if not exists secret_ciphertext text;

comment on column public.radius_nas.secret_ciphertext is
  'Per-router RADIUS shared secret, AES-256-GCM encrypted with '
  'ROUTER_CREDENTIALS_KEY in the same envelope as router_credentials. '
  'SERVICE ROLE ONLY: never select this column from a browser session.';

-- ── Take the column away from the browser ────────────────────────────────
--
-- A column grant is required, not optional. The RLS policy on radius_nas is
-- per-row and says nothing about columns, so `authenticated` could otherwise
-- `select secret_ciphertext` for its own tenant and read every router's RADIUS
-- credential out of a devtools tab.
--
-- The safe columns are re-granted by name so the panel keeps working: the wizard
-- shows nas_identifier and secret_set and nothing more.
revoke select on public.radius_nas from authenticated;
grant select (
  id, isp_id, node_id, nas_identifier, client_ip, secret_set,
  created_at, updated_at
) on public.radius_nas to authenticated;

comment on column public.radius_nas.secret_set is
  'True when a shared secret is stored for this router. The VALUE lives in '
  'secret_ciphertext and is service-role only; this flag exists so the panel can '
  'say "configured" without being able to read it.';

-- ── The worker fetches it ────────────────────────────────────────────────
--
-- Service role only, and scoped by node_id AND isp_id together so a job row
-- that has been tampered with cannot ask for another tenant's secret.
create or replace function public.radius_nas_secret_for_node(
  p_node_id uuid,
  p_isp_id  uuid
) returns text
language sql stable security definer set search_path = public as $$
  select n.secret_ciphertext
    from public.radius_nas n
    join public.nodes nd on nd.id = n.node_id
   where n.node_id = p_node_id
     and n.isp_id = p_isp_id
     and nd.isp_id = p_isp_id
   limit 1;
$$;

comment on function public.radius_nas_secret_for_node(uuid, uuid) is
  'Returns the ENCRYPTED secret for one router, for the worker to decrypt in '
  'memory. Service role only, and requires BOTH ids to agree so a tampered job '
  'row cannot read another tenant''s credential.';

revoke all on function public.radius_nas_secret_for_node(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.radius_nas_secret_for_node(uuid, uuid) to service_role;

-- ── Store one, without ever returning it ─────────────────────────────────
--
-- Takes an already-encrypted value, stores it, and keeps `secret_set` in step
-- so the panel's "configured" indicator can never disagree with what is stored.
-- The caller does the encryption; this function never sees plaintext.
create or replace function public.set_radius_nas_secret(
  p_node_id uuid,
  p_isp_id  uuid,
  p_ciphertext text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows integer;
begin
  if p_isp_id is null or p_node_id is null then
    return jsonb_build_object('ok', false, 'error', 'node and isp are required.');
  end if;
  if p_ciphertext is null or p_ciphertext = '' then
    return jsonb_build_object('ok', false, 'error', 'The ciphertext is empty.');
  end if;

  update public.radius_nas
     set secret_ciphertext = p_ciphertext,
         secret_set = true,
         updated_at = now()
   where node_id = p_node_id and isp_id = p_isp_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- No NAS row yet. Creating one is correct: a registered router needs a trust
    -- anchor before it can be authenticated at all.
    insert into public.radius_nas (isp_id, node_id, nas_identifier, secret_ciphertext, secret_set)
    select p_isp_id, p_node_id,
           -- Deterministic and unique: the router's own name sanitised to the
           -- shape radius_nas_identifier_ck allows. FreeRADIUS keys tenant
           -- resolution on this exact string, so it must be STABLE across
           -- re-provisioning - a changing identifier would make the same physical
           -- router suddenly be a different client.
           regexp_replace(coalesce(nd.name, 'router'), '[^A-Za-z0-9._-]', '-', 'g'),
           p_ciphertext, true
      from public.nodes nd
     where nd.id = p_node_id and nd.isp_id = p_isp_id
    on conflict (nas_identifier) do update
      set secret_ciphertext = excluded.secret_ciphertext,
          secret_set = true,
          updated_at = now();
    get diagnostics v_rows = row_count;
  end if;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'error', 'Router not found in this ISP.');
  end if;

  -- Reports only that something was stored, never anything about its value.
  return jsonb_build_object('ok', true, 'stored', true);
end;
$$;

comment on function public.set_radius_nas_secret(uuid, uuid, text) is
  'Stores an already-encrypted RADIUS secret for a router. The caller encrypts '
  'with ROUTER_CREDENTIALS_KEY; this function never sees plaintext and never '
  'returns the value.';

revoke all on function public.set_radius_nas_secret(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_radius_nas_secret(uuid, uuid, text) to service_role;

-- =============================================================================
--  2. STATIC AS A PACKAGE KIND
-- =============================================================================
--
--  Checked before adding: `static` exists NOWHERE in ISPFlow. plans.kind is
-- ('hotspot','fiber','pppoe'), the portal filters on those, the storefront lists
-- those, and Copy Plans has nothing to copy for a static-IP service. The task
-- asks for it, so this is the smallest additive model that represents it.
--
--  It is a KIND on the existing `plans` table, not a new billing system. A
--  static package is a package: it has a name, a price, speeds, a duration and
--  an active flag, it is sold through the same storefront and settled by the
--  same payment path. What is different is that on the router it becomes a
--  fixed address rather than a session.
--
--  The constraint is replaced rather than dropped, which keeps it a CHECK and
--  keeps every existing row valid: 'static' is ADDED to the list, so no plan is
--  rejected and no data changes.
alter table public.plans
  drop constraint if exists plans_kind_check;

alter table public.plans
  add constraint plans_kind_check
  check (kind in ('hotspot','fiber','pppoe','static'));

comment on column public.plans.kind is
  'Service the package delivers. "static" is a fixed-address service: billed and '
  'renewed like any other package, but provisioned as a static entry rather than '
  'a session.';

-- ── Copy Plans understands it ─────────────────────────────────────────────
--
-- The existing copy function filters on `p_kinds`, so 'static' is copyable the
-- moment it can be a kind. No change to the copy logic is needed, which is the
-- point: this did not become a second copy system.
comment on function public.copy_router_plans(uuid, uuid, text[], boolean) is
  'Copies a package catalogue from another router OF THE SAME ISP. The tenant '
  'check runs before any plan is read. Copies plan definitions only, never the '
  'source router''s live RouterOS objects, and never a price or a payment. '
  'Accepts hotspot, pppoe, fiber and static.';

commit;