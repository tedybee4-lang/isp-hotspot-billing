-- =============================================================================
--  RLS for every domain table.
--
--  Rule: a row is visible only when isp_id matches the tenant derived from the
--  caller's authenticated profile. There is NO code path where isp_id is taken
--  from a URL, query string or request body — it always comes from
--  public.current_isp_id(), which reads the signed-in profile.
-- =============================================================================

-- ── Permission helper ────────────────────────────────────────────────────────
-- Owners and admins may act throughout their own tenant. Everyone else needs an
-- explicit grant from isp_roles via profile_assignments. Note that an ISP
-- owner's assignment is optional: they hold every permission implicitly.
--
-- An earlier version returned true for ANY staff role, which silently defeated
-- fine-grained permissions — restricted staff could read and write everything.
create or replace function public.has_permission(p_permission text)
  returns boolean language sql stable security definer set search_path = public as $$
  select
    public.is_super_admin()
    or (
      public.current_isp_id() is not null
      and exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and p.role in ('isp_owner', 'isp_admin')
          and p.is_active
      )
    )
    or exists (
      select 1
      from public.profile_assignments pa
      join public.isp_roles r on r.id = pa.role_id
      where pa.profile_id = auth.uid()
        and pa.isp_id   = public.current_isp_id()
        and p_permission = any(r.permissions)
    );
$$;

-- Tenant tables that staff may read and write.
create or replace function public.can_write_tenant()
  returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or (public.current_isp_id() is not null and public.is_isp_staff());
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'service_accounts','renewals','transactions',
    'sms_templates','sms_messages',
    'resellers','commissions','expenses',
    'inventory_items','inventory_movements',
    'isp_api_keys','isp_webhooks','webhook_deliveries',
    'notifications','isp_roles','profile_assignments'
  ] loop

    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    -- READ: only your own tenant
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select using (
         public.is_super_admin() or isp_id = public.current_isp_id())',
      t || '_read', t);

    -- WRITE: only your own tenant, and only staff
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format(
      'create policy %I on public.%I for insert with check (
         public.is_super_admin() or (isp_id = public.current_isp_id() and public.can_write_tenant()))',
      t || '_write', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update using (
         public.is_super_admin() or (isp_id = public.current_isp_id() and public.can_write_tenant()))
       with check (
         public.is_super_admin() or (isp_id = public.current_isp_id() and public.can_write_tenant()))',
      t || '_update', t);

    -- DELETE: super admin, or owner/admin of this tenant
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete using (
         public.is_super_admin()
         or (isp_id = public.current_isp_id() and public.can_manage_isp()))',
      t || '_delete', t);
  end loop;
end $$;

-- `profile_assignments` has no isp_id on the row itself (it is the tenant id),
-- so it needs its own policies rather than the generic loop.
drop policy if exists profile_assignments_read on public.profile_assignments;
create policy profile_assignments_read on public.profile_assignments for select
  using (public.is_super_admin() or isp_id = public.current_isp_id() or profile_id = auth.uid());

drop policy if exists profile_assignments_write on public.profile_assignments;
create policy profile_assignments_write on public.profile_assignments for all
  using (public.is_super_admin() or (isp_id = public.current_isp_id() and public.can_manage_isp()))
  with check (public.is_super_admin() or (isp_id = public.current_isp_id() and public.can_manage_isp()));

-- Notifications are personal, not tenant-wide.
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select
  using (public.is_super_admin() or user_id = auth.uid());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- `permission_definitions` is global reference data: readable by any signed-in user.
alter table public.permission_definitions enable row level security;
drop policy if exists permission_definitions_read on public.permission_definitions;
create policy permission_definitions_read on public.permission_definitions for select
  using (auth.uid() is not null);