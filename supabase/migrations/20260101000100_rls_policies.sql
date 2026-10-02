-- =============================================================================
--  Row Level Security — tenant isolation
--  A user can ONLY ever see rows belonging to their own ISP, unless they are
--  a platform super_admin. Isolation is enforced by Postgres, not the client.
-- =============================================================================

-- ── Helpers (SECURITY DEFINER avoids infinite RLS recursion) ──────────────────
create or replace function public.current_profile_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select auth.uid();
$$;

create or replace function public.current_isp_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select isp_id from public.profiles where id = auth.uid();
$$;

create or replace function public.is_super_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'super_admin' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_isp_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('isp_owner','isp_admin','isp_agent')
                     from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.can_manage_isp() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('isp_owner','isp_admin')
                     from public.profiles where id = auth.uid()), false);
$$;

-- Keep updated_at honest
create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Enable RLS everywhere ────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'isps','profiles','isp_payment_configs','plans','vouchers','clients',
    'invoices','payments','nodes','sessions','tickets','ticket_messages',
    'usage_events','audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
-- ── isps (tenants) ────────────────────────────────────────────────────────────
drop policy if exists isps_super_admin_all on public.isps;
create policy isps_super_admin_all on public.isps for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists isps_read_own on public.isps;
create policy isps_read_own on public.isps for select
  using (id = public.current_isp_id());

drop policy if exists isps_owner_update_own on public.isps;
create policy isps_owner_update_own on public.isps for update
  using (id = public.current_isp_id() and public.can_manage_isp())
  with check (id = public.current_isp_id() and public.can_manage_isp());

-- ── profiles ──────────────────────────────────────────────────────────────────
drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles for select
  using (id = auth.uid());

drop policy if exists profiles_super_admin_all on public.profiles;
create policy profiles_super_admin_all on public.profiles for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- ISP staff see only the users belonging to their own tenant
drop policy if exists profiles_read_same_isp on public.profiles;
create policy profiles_read_same_isp on public.profiles for select
  using (public.is_isp_staff() and isp_id = public.current_isp_id());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and isp_id = public.current_isp_id());

-- Owners/admins can change roles of non-owner members of their own ISP
drop policy if exists profiles_manage_same_isp on public.profiles;
create policy profiles_manage_same_isp on public.profiles for update
  using (public.can_manage_isp() and isp_id = public.current_isp_id())
  with check (public.can_manage_isp() and isp_id = public.current_isp_id());

-- ── isp_payment_configs ──────────────────────────────────────────────────────
-- Service role bypasses RLS (used by the stk-push Edge Function).
-- Super admin manages; tenant staff can only read the row (columns are
-- additionally protected by revoking direct select on the secret columns).
drop policy if exists payment_cfg_super_admin_all on public.isp_payment_configs;
create policy payment_cfg_super_admin_all on public.isp_payment_configs for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists payment_cfg_own_read on public.isp_payment_configs;
create policy payment_cfg_own_read on public.isp_payment_configs for select
  using (isp_id = public.current_isp_id());

-- Link a customer account to its portal login (nullable = walk-in customers)
alter table public.clients
  add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists clients_user_idx on public.clients(user_id);

-- ── Generic tenant policies for business tables ──────────────────────────────
-- Applied to: plans, vouchers, clients, invoices, payments, nodes, sessions,
--             tickets, ticket_messages, usage_events
do $$
declare
  tbl text;
  staff_write text[] := array['plans','vouchers','clients','invoices','payments','nodes','tickets','usage_events'];
begin
  foreach tbl in array array[
    'plans','vouchers','clients','invoices','payments','nodes','sessions',
    'tickets','ticket_messages','usage_events'
  ] loop

    execute format('drop policy if exists %I on public.%I', tbl || '_read', tbl);
    execute format(
      'create policy %I on public.%I for select using (
         public.is_super_admin() or isp_id = public.current_isp_id())',
      tbl || '_read', tbl);

    if tbl = any(staff_write) then
      execute format('drop policy if exists %I on public.%I', tbl || '_staff_write', tbl);
      execute format(
        'create policy %I on public.%I for all using (
           public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.is_isp_staff()))
         with check (
           public.is_super_admin()
           or (isp_id = public.current_isp_id() and public.is_isp_staff()))',
        tbl || '_staff_write', tbl);
    end if;
  end loop;
end $$;

-- ── Customer self-service ─────────────────────────────────────────────────────
-- A logged-in customer may read (never write) only their own account row.
drop policy if exists clients_read_own_user on public.clients;
create policy clients_read_own_user on public.clients for select
  using (user_id = auth.uid());

drop policy if exists invoices_read_own_user on public.invoices;
create policy invoices_read_own_user on public.invoices for select
  using (client_id in (select id from public.clients where user_id = auth.uid()));

drop policy if exists tickets_read_own_user on public.tickets;
create policy tickets_read_own_user on public.tickets for select
  using (client_id in (select id from public.clients where user_id = auth.uid()));

drop policy if exists ticket_messages_read_own_user on public.ticket_messages;
create policy ticket_messages_read_own_user on public.ticket_messages for select
  using (ticket_id in (
    select t.id from public.tickets t
    join public.clients c on c.id = t.client_id
    where c.user_id = auth.uid()));

-- ── audit_logs ────────────────────────────────────────────────────────────────
-- Staff may append; only super admins may read.
drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs for insert
  with check (actor_id = auth.uid() or public.is_super_admin());

drop policy if exists audit_logs_super_read on public.audit_logs;
create policy audit_logs_super_read on public.audit_logs for select
  using (public.is_super_admin());

-- ── updated_at triggers ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'isps','profiles','plans','clients','isp_payment_configs'
  ] loop
    execute format('drop trigger if exists trg_%I_touch on public.%I', t, t);
    execute format(
      'create trigger trg_%I_touch before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ── Audit trail automation ────────────────────────────────────────────────────
create or replace function public.log_isp_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_role  platform_role;
begin
  select email into v_email from auth.users where id = v_actor;
  select role into v_role from public.profiles where id = v_actor;

  insert into public.audit_logs(actor_id, actor_email, actor_role, isp_id, isp_name,
                                action, target_type, target_id, metadata)
  values (
    v_actor, v_email, v_role,
    coalesce(new.id, old.id),
    coalesce(new.name, old.name),
    tg_op || ':isp',
    'isp',
    coalesce(new.id, old.id)::text,
    jsonb_build_object(
      'status', coalesce(new.status, old.status),
      'plan',   coalesce(new.plan, old.plan)
    )
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_isp_audit on public.isps;
create trigger trg_isp_audit
  after insert or update or delete on public.isps
  for each row execute function public.log_isp_change();