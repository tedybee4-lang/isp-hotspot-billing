-- =============================================================================
--  Enable row level security on four tables that were readable by every
--  signed-in user in every tenant.
--
--  Found by asking the database who could read what, rather than assuming the
--  policies were in place:
--
--      select relname from pg_class c ...
--       where not c.relrowsecurity
--         and has_table_privilege('authenticated', c.oid, 'select');
--
--      platform_admins, platform_settings, radius_nas, radius_sessions
--
--  RLS was disabled on all four while `authenticated` held a table-wide SELECT
--  grant (the default Supabase applies on new tables). RLS disabled means the
--  grant is the only control, and a table-wide grant is not a tenant boundary.
--  Every authenticated user could therefore read:
--
--    * every ISP's RADIUS sessions - customer usernames, framed IPs, usage,
--      durations and router names, across all tenants
--    * every registered router identifier
--    * the platform administrator list, which is a targeting list
--    * platform settings
--
--  This is a cross-tenant data breach, and it is closed here.
--
--  Nothing else changes. The RADIUS server connects as `radius_reader`, which
--  holds explicit per-table grants and is not `authenticated`; the network
--  worker uses the service role, which bypasses RLS by design. The read model
--  added in 20260101180000 is SECURITY DEFINER, so the live-users panel is
--  unaffected. Enabling RLS only removes access from a plain client query that
--  had no business reading another tenant's rows.
-- =============================================================================

begin;

-- ── radius_sessions: the customer session record ─────────────────────────────
alter table public.radius_sessions enable row level security;

drop policy if exists radius_sessions_tenant_read on public.radius_sessions;
create policy radius_sessions_tenant_read on public.radius_sessions
  for select
  using (isp_id = public.current_isp_id() or public.is_super_admin());

-- No INSERT/UPDATE/DELETE policy is added on purpose. Every legitimate write
-- goes through FreeRADIUS (radius_reader) or the worker (service_role). Letting
-- a browser write its own session rows would let an ISP fabricate usage
-- evidence for billing.

-- ── radius_nas: registered routers ──────────────────────────────────────────
alter table public.radius_nas enable row level security;

drop policy if exists radius_nas_tenant_read on public.radius_nas;
create policy radius_nas_tenant_read on public.radius_nas
  for select
  using (isp_id = public.current_isp_id() or public.is_super_admin());

-- ── platform_admins: who can administer the platform ────────────────────────
--
-- Super-admin only. An ISP has no business knowing the platform's admin roster;
-- it is a list of accounts whose password reset takes the whole platform down.
alter table public.platform_admins enable row level security;

drop policy if exists platform_admins_super_read on public.platform_admins;
create policy platform_admins_super_read on public.platform_admins
  for select
  using (public.is_super_admin());

-- ── platform_settings ───────────────────────────────────────────────────────
--
-- Super-admin only. This table is the reason the other three matter: anything
-- stored here is, by definition, platform-wide, and there is no per-tenant
-- reading of it that is correct.
alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_super_read on public.platform_settings;
create policy platform_settings_super_read on public.platform_settings
  for select
  using (public.is_super_admin());

comment on table public.radius_sessions is
  'RADIUS accounting sessions. RLS-enabled: readable only by the owning ISP. '
  'Writes come from FreeRADIUS (radius_reader) and the worker (service_role), '
  'never from a browser.';

-- A live self-check for the RLS posture applied above.
--
-- The migration proves the intent; this proves the resulting database state is
-- what the intent claims, so a future migration that disables RLS again is
-- caught by the test suite rather than by a customer noticing. It reports NAMES
-- of tables, never their contents, so it cannot itself become an information
-- leak, and it is executable only by the service role.
create or replace function public.unprotected_selectable_tables()
returns text[]
  language sql
  stable
  security definer
  set search_path = public as $$
  select coalesce(array_agg(c.relname order by c.relname), '{}'::text[])
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and has_table_privilege('authenticated', c.oid, 'select')
     and not c.relrowsecurity;
$$;

revoke all on function public.unprotected_selectable_tables() from public;
grant execute on function public.unprotected_selectable_tables() to service_role;

comment on function public.unprotected_selectable_tables() is
  'Names of public tables an authenticated client can read with RLS disabled. '
  'Must return an empty array. Executable only by the service role.';

commit;