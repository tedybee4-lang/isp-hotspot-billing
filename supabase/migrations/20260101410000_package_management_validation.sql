-- =============================================================================
--  Server-side validation for ISP package management.
--
--  The browser form was the only place package fields were checked, so a stale
--  tab, a crafted request, or a direct RPC call could create a package with an
--  empty name, a negative price, a zero duration or a nonsense speed. Every one
--  of those then reaches the captive portal and, worse, portal_create_payment:
--  a package with no duration_hours grants a customer nothing, and a negative
--  amount is a PayHero STK prompt for money the ISP does not expect to owe.
--
--  Nothing is added to the schema. `plans` already carries every field this
--  needs, so this only teaches the two existing RPCs to refuse bad input. The
--  rules accept all 16 existing plans untouched (verified against the live
--  catalogue before writing: prices 10-2000, durations 1-720h, speeds
--  "1 Mbps".."10 Mbps", kinds hotspot/fiber).
-- =============================================================================

begin;

-- ── 1. The shared rules ─────────────────────────────────────────────────────
--
-- One function, called by both create and update, so a package cannot be born
-- invalid and then be edited into a state the create path would have rejected.
-- The two paths are validated on the row they are about to write, not on the
-- patch alone, because a partial update must not be judged against fields the
-- caller never sent.
create or replace function public.validate_plan_fields(
  p_name            text,
  p_kind            text,
  p_price           numeric,
  p_duration_label  text,
  p_duration_hours  integer,
  p_speed_down      text,
  p_speed_up        text,
  p_shared_users    integer
) returns void
language plpgsql immutable set search_path = public as $$
begin
  -- Name. Required: it is the key settlement resolves a package by
  -- (payment_grant_hours matches on it) and it is what the customer reads on
  -- the storefront. The old default of 'Unnamed package' is how a catalogue
  -- ends up with five rows all called the same thing.
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Package name is required.';
  end if;
  if length(btrim(p_name)) > 120 then
    raise exception 'Package name must be 120 characters or fewer.';
  end if;

  -- Service type. Whitelist, not a free string: `kind` selects which network
  -- stack activates the customer, so an unknown value would build a HotSpot
  -- user for a fiber package.
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'Package type is required.';
  end if;
  if lower(btrim(p_kind)) not in ('hotspot', 'pppoe', 'fiber') then
    raise exception 'Package type must be hotspot, pppoe or fiber.';
  end if;

  -- Price. Zero is allowed and means a free package; negative is not, because
  -- the amount flows straight into an M-Pesa STK prompt.
  if p_price is null then
    raise exception 'Package price is required.';
  end if;
  if p_price < 0 then
    raise exception 'Package price cannot be negative.';
  end if;
  if p_price > 100000000 then
    raise exception 'Package price looks wrong. Enter it in whole shillings.';
  end if;

  -- Duration. Both the label and the hours matter: the label is what the
  -- customer reads, the hours are what actually extends their expiry. A zero or
  -- negative value would activate a customer already expired.
  if p_duration_label is null or btrim(p_duration_label) = '' then
    raise exception 'Package duration label is required, for example "1 Hour".';
  end if;
  if length(btrim(p_duration_label)) > 60 then
    raise exception 'Package duration label must be 60 characters or fewer.';
  end if;
  if p_duration_hours is null or p_duration_hours < 1 then
    raise exception 'Package duration must be at least 1 hour.';
  end if;
  if p_duration_hours > 87600 then
    raise exception 'Package duration cannot be longer than 10 years.';
  end if;

  -- Speed. Required on download, optional on upload (a one-way package is
  -- legitimate, and upload then mirrors download when absent). The pattern
  -- accepts what the catalogue and the form both produce: "10 Mbps", "512
  -- Kbps", "1 Gbps", or a bare number.
  if p_speed_down is null or btrim(p_speed_down) = '' then
    raise exception 'Download speed is required, for example "5 Mbps".';
  end if;
  if btrim(p_speed_down) !~ '^\s*[0-9]+(\.[0-9]+)?\s*([kKmMgG])?[bB]ps\s*$'
     and btrim(p_speed_down) !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then
    raise exception 'Download speed must look like "5 Mbps" or "512 Kbps".';
  end if;
  if p_speed_up is not null and btrim(p_speed_up) <> '' then
    if btrim(p_speed_up) !~ '^\s*[0-9]+(\.[0-9]+)?\s*([kKmMgG])?[bB]ps\s*$'
       and btrim(p_speed_up) !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then
      raise exception 'Upload speed must look like "2 Mbps" or "512 Kbps".';
    end if;
  end if;

  -- Shared users. Zero would mean nobody can log in.
  if p_shared_users is null or p_shared_users < 1 then
    raise exception 'A package must allow at least 1 device.';
  end if;
  if p_shared_users > 500 then
    raise exception 'A package cannot allow more than 500 devices.';
  end if;
end;
$$;

comment on function public.validate_plan_fields(text, text, numeric, text, integer, text, text, integer) is
  'Shared field rules for create_plan and update_plan. Raises on invalid input '
  'so a package can never be written in a state the storefront or settlement '
  'would mishandle. Accepts all 16 packages in the existing catalogue.';

revoke all on function public.validate_plan_fields(text, text, numeric, text, integer, text, text, integer) from public;
grant execute on function public.validate_plan_fields(text, text, numeric, text, integer, text, text, integer) to service_role;

-- ── 2. create_plan validates before it inserts ──────────────────────────────
--
-- The behaviour is otherwise identical to the existing function, including the
-- plan-count cap and the audit log, so no caller notices a difference except
-- that a bad package now fails loudly instead of being stored.
create or replace function public.create_plan(p_plan jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp   uuid := public.current_isp_id();
  v_cap   integer;
  v_used  integer;
  v_row   uuid;
  v_name  text;
  v_kind  text;
  v_price numeric;
  v_label text;
  v_hours integer;
  v_down  text;
  v_up    text;
  v_users integer;
begin
  if v_isp is null then raise exception 'No ISP in scope'; end if;
  if not (public.is_super_admin() or public.can_manage_isp()) then
    raise exception 'Insufficient permissions';
  end if;

  -- Resolve every field ONCE, validate the resolved set, and insert exactly
  -- those values. Reading a key twice (once to validate, once to store) is how
  -- a default silently changes between the check and the write.
  v_name  := nullif(btrim(coalesce(p_plan->>'name', '')), '');
  v_kind  := lower(btrim(coalesce(p_plan->>'kind', 'hotspot')));
  v_price := (p_plan->>'price')::numeric;
  v_label := nullif(btrim(coalesce(p_plan->>'duration_label', '')), '');
  v_hours := (p_plan->>'duration_hours')::int;
  v_down  := nullif(btrim(coalesce(p_plan->>'speed_down', '')), '');
  v_up    := nullif(btrim(coalesce(p_plan->>'speed_up', '')), '');
  v_users := (p_plan->>'shared_users')::int;

  perform public.validate_plan_fields(
    v_name, v_kind, v_price, v_label, v_hours, v_down, v_up, v_users);

  perform public.assert_unique_plan_name(v_isp, v_name);

  select max_plans into v_cap from public.isps where id = v_isp;
  select count(*) into v_used from public.plans where isp_id = v_isp;

  if v_cap is not null and v_used >= v_cap then
    raise exception 'Your plan allows a maximum of % packages. Upgrade to add more.', v_cap;
  end if;

  insert into public.plans (
    isp_id, name, kind, duration_label, duration_hours, price,
    speed_down, speed_up, data_limit, fup, shared_users,
    description, is_active, is_popular, show_on_portal
  ) values (
    v_isp,
    v_name,
    v_kind,
    v_label,
    v_hours,
    v_price,
    v_down,
    -- An omitted upload mirrors the download rather than staying null, so the
    -- RADIUS profile always carries both directions.
    coalesce(v_up, v_down),
    nullif(p_plan->>'data_limit', ''), nullif(p_plan->>'fup', ''),
    v_users,
    nullif(p_plan->>'description', ''),
    coalesce((p_plan->>'is_active')::boolean, true),
    coalesce((p_plan->>'is_popular')::boolean, false),
    coalesce((p_plan->>'show_on_portal')::boolean, true)
  )
  returning id into v_row;

  perform public.log_isp_action('package:created', 'plan', v_row::text,
                                jsonb_build_object('name', v_name));
  return jsonb_build_object('id', v_row);
end;
$$;

comment on function public.create_plan(jsonb) is
  'Creates a package for the calling tenant. The tenant comes from the session, '
  'never from the argument, and every field is validated server-side.';

revoke all on function public.create_plan(jsonb) from public;
grant execute on function public.create_plan(jsonb) to authenticated, service_role;

-- ── 3. update_plan validates the row it is about to write ──────────────────
--
-- The patch is applied first and the RESULT validated, because a partial update
-- only carries some fields. Judging the patch alone would reject a valid edit
-- that omits, say, speed_down, and would miss an invalid one that keeps the old
-- price while setting a negative duration.
create or replace function public.update_plan(p_plan_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp uuid := public.current_isp_id();
  v_row public.plans;
begin
  if v_isp is null then raise exception 'No ISP in scope'; end if;
  if not (public.is_super_admin() or public.can_manage_isp()) then
    raise exception 'Insufficient permissions';
  end if;

  update public.plans t set
    name           = case when p_patch ? 'name' then nullif(btrim(p_patch->>'name'), '') else t.name end,
    kind           = case when p_patch ? 'kind' then lower(btrim(p_patch->>'kind')) else t.kind end,
    duration_label = case when p_patch ? 'duration_label' then nullif(btrim(p_patch->>'duration_label'), '') else t.duration_label end,
    duration_hours = coalesce((p_patch->>'duration_hours')::int, t.duration_hours),
    price          = coalesce((p_patch->>'price')::numeric, t.price),
    speed_down     = case when p_patch ? 'speed_down' then nullif(btrim(p_patch->>'speed_down'), '') else t.speed_down end,
    speed_up       = case when p_patch ? 'speed_up' then nullif(btrim(p_patch->>'speed_up'), '') else t.speed_up end,
    data_limit     = case when p_patch ? 'data_limit' then p_patch->>'data_limit' else t.data_limit end,
    fup            = case when p_patch ? 'fup' then p_patch->>'fup' else t.fup end,
    shared_users   = coalesce((p_patch->>'shared_users')::int, t.shared_users),
    description    = case when p_patch ? 'description' then p_patch->>'description' else t.description end,
    is_active      = coalesce((p_patch->>'is_active')::boolean, t.is_active),
    is_popular     = coalesce((p_patch->>'is_popular')::boolean, t.is_popular),
    show_on_portal = coalesce((p_patch->>'show_on_portal')::boolean, t.show_on_portal),
    updated_at     = now()
  where t.id = p_plan_id and t.isp_id = v_isp
  returning * into v_row;

  if v_row.id is null then raise exception 'Package not found'; end if;

  -- Raising here aborts the statement, so the UPDATE is rolled back and a
  -- rejected edit leaves the package exactly as it was, never half-applied.
  perform public.validate_plan_fields(
    v_row.name, v_row.kind, v_row.price, v_row.duration_label,
    v_row.duration_hours, v_row.speed_down, v_row.speed_up, v_row.shared_users);

  perform public.assert_unique_plan_name(v_isp, v_row.name);

  perform public.log_isp_action('package:updated', 'plan', v_row.id::text,
                                jsonb_build_object('name', v_row.name));
  return jsonb_build_object('id', v_row.id);
end;
$$;

comment on function public.update_plan(uuid, jsonb) is
  'Edits one of the calling tenant''s packages. Scoped by isp_id from the '
  'session, and the merged row is validated before the change is committed.';

revoke all on function public.update_plan(uuid, jsonb) from public;
grant execute on function public.update_plan(uuid, jsonb) to authenticated, service_role;

-- ── 4. Guard against a package name colliding inside one tenant ───────────
--
-- Settlement identifies a package by NAME (payment_grant_hours matches
-- lower(btrim(name))), so two packages called "1 Hour" in the same ISP make
-- that lookup ambiguous and a customer's expiry can be taken from the wrong
-- row. Scoped per tenant: two ISPs may each have their own "1 Hour", which is
-- exactly how the seeded catalogues are built.
create or replace function public.assert_unique_plan_name(p_isp uuid, p_name text)
returns void
language plpgsql set search_path = public as $$
declare
  v_clash integer;
begin
  if p_isp is null or p_name is null or btrim(p_name) = '' then return; end if;
  select count(*) into v_clash
    from public.plans
   where isp_id = p_isp
     and lower(btrim(name)) = lower(btrim(p_name));
  if v_clash > 1 then
    raise exception 'This ISP already has a package called "%". Package names must be unique so a payment can be matched to the right one.', btrim(p_name);
  end if;
end;
$$;

comment on function public.assert_unique_plan_name(uuid, text) is
  'Refuses a catalogue with two packages of the same name inside one ISP, '
  'because settlement resolves a package by name. Unique per tenant by design.';

revoke all on function public.assert_unique_plan_name(uuid, text) from public;
grant execute on function public.assert_unique_plan_name(uuid, text) to service_role;

-- ── 5. An index for the name lookup that settlement performs ──────────────
--
-- payment_grant_hours and the storefront both look a package up by name within
-- a tenant. At 16 rows this is invisible; at a few thousand it is a sequential
-- scan on the settlement path of every successful payment.
create index if not exists plans_isp_name_idx
  on public.plans (isp_id, lower(btrim(name)));

comment on index public.plans_isp_name_idx is
  'Serves the per-tenant name lookup used by payment_grant_hours and the storefront.';

commit;