-- =============================================================================
--  Signup, provisioning & platform analytics
-- =============================================================================

-- ── Auto-profile creation on signup ───────────────────────────────────────────
-- New auth users start as 'client' with no tenant. They are upgraded to
-- isp_owner by signup_isp(), or to super_admin via the BOOTSTRAP list.
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Emails listed here are promoted to super_admin on first login.
create table if not exists public.platform_admins (
  email      text primary key,
  full_name  text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_is_admin boolean;
begin
  select exists(select 1 from public.platform_admins where lower(email) = lower(new.email))
    into v_is_admin;

  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    case when v_is_admin then 'super_admin'::platform_role else 'client'::platform_role end,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do update
    set role = case when v_is_admin then 'super_admin'::platform_role else public.profiles.role end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- ── Tenant self-registration ──────────────────────────────────────────────────
-- Called by a signed-in user from the "Register your ISP" screen.
-- Creates the tenant + upgrades the caller to isp_owner, atomically.
create or replace function public.signup_isp(
  p_name        text,
  p_slug        text,
  p_phone       text default null,
  p_country     text default 'KE',
  p_county      text default null,
  p_city        text default null,
  p_address     text default null,
  p_brand_color text default '#7c3aed'
) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_isp   uuid;
  v_slug  text;
  v_email text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.profiles where id = v_uid and isp_id is not null) then
    raise exception 'You already belong to an ISP on this platform.';
  end if;

  v_slug := lower(regexp_replace(trim(coalesce(p_slug, '')), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug is null or length(v_slug) < 3 then
    raise exception 'Slug must be at least 3 characters.';
  end if;
  if exists (select 1 from public.isps where slug = v_slug) then
    raise exception 'That subdomain is already taken. Try another.';
  end if;

  select email into v_email from auth.users where id = v_uid;

  insert into public.isps (name, slug, status, plan, contact_email, contact_phone,
                           country, county, city, address, brand_color, trial_ends_at)
  values (trim(p_name), v_slug, 'trial', 'starter', v_email, p_phone,
          coalesce(p_country,'KE'), p_county, p_city, p_address, p_brand_color,
          now() + interval '14 days')
  returning id into v_isp;

  update public.profiles
     set isp_id = v_isp, role = 'isp_owner', updated_at = now()
   where id = v_uid;

  insert into public.isp_payment_configs (isp_id) values (v_isp);

  insert into public.plans (isp_id, name, kind, duration_label, duration_hours, price, speed_down, speed_up, shared_users, is_popular)
  values
    (v_isp, 'Hourly Hotspot', 'hotspot', '1 Hour',    1,    10, '1 Mbps',  '2 Mbps',  1, false),
    (v_isp, 'Daily Hotspot',  'hotspot', '24 Hours',  24,   40, '2 Mbps',  '4 Mbps',  1, true),
    (v_isp, 'Weekly Hotspot', 'hotspot', '7 Days',    168,  245, '3 Mbps',  '3 Mbps',  3, false),
    (v_isp, 'Home Fiber 5M',  'fiber',   'Monthly',   720,  1500,'5 Mbps', '5 Mbps',  5, true),
    (v_isp, 'Home Fiber 10M', 'fiber',   'Monthly',   720,  2000,'10 Mbps','10 Mbps', 10, false);

  -- Seed the staff roles so Roles & Permissions is populated from day one.
  -- Without this a brand new ISP has no isp_roles rows, which also means
  -- has_permission() can never grant anything to a non-owner staff member.
  perform public.seed_default_roles(v_isp);

  return v_isp;
end;
$$;

grant execute on function public.signup_isp(text,text,text,text,text,text,text,text)
  to authenticated;

-- ── Super-admin operations ────────────────────────────────────────────────────
-- Guard used by every function below.
create or replace function public.require_super_admin() returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then
    raise exception 'Super admin privileges required';
  end if;
end;
$$;

-- Set tenant lifecycle state (activate / suspend / churn / back to trial)
create or replace function public.set_isp_status(p_isp_id uuid, p_status isp_status)
  returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  update public.isps
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         onboarded_at = case when p_status = 'active' and onboarded_at is null then now() else onboarded_at end
   where id = p_isp_id;
end;
$$;

-- Change a tenant's commercial tier and seat limits
create or replace function public.set_isp_plan(
  p_isp_id uuid, p_plan isp_plan, p_max_clients int, p_max_plans int, p_max_nodes int
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  update public.isps
     set plan = p_plan, max_clients = p_max_clients,
         max_plans = p_max_plans, max_nodes = p_max_nodes
   where id = p_isp_id;
end;
$$;

-- Full tenant offboarding (cascade wipes all tenant data)
create or replace function public.delete_isp(p_isp_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  delete from public.isps where id = p_isp_id;
end;
$$;

-- Inviting staff users is done by the `admin-invite` Edge Function using the
-- service role (Supabase does not allow creating auth.users rows from SQL).
-- It calls set_isp_staff_role() below to attach the tenant + role.

create or replace function public.set_isp_staff_role(
  p_user_id uuid, p_isp_id uuid, p_role platform_role
) returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  if p_role in ('super_admin') then
    raise exception 'Use platform_admins table to grant super admin';
  end if;
  update public.profiles
     set isp_id = p_isp_id, role = p_role, updated_at = now()
   where id = p_user_id;
end;
$$;

grant execute on function public.set_isp_status(uuid, isp_status) to authenticated;
grant execute on function public.set_isp_plan(uuid, isp_plan, int, int, int) to authenticated;
grant execute on function public.delete_isp(uuid) to authenticated;
grant execute on function public.set_isp_staff_role(uuid, uuid, platform_role) to authenticated;

-- ── M-Pesa configuration (super admin) ────────────────────────────────────────
-- Returns readiness WITHOUT exposing the secrets: the caller gets booleans,
-- never the raw passkey / consumer key / secret.
--
-- The DROP makes this file re-runnable. Migration 20260101000300 widens the
-- return type, and PostgreSQL refuses to change a function's OUT parameters
-- under CREATE OR REPLACE, so the old signature has to go first.
drop function if exists public.payment_config_status(uuid);
create or replace function public.payment_config_status(p_isp_id uuid)
  returns table (
    mpesa_env      text,
    mpesa_shortcode text,
    callback_url   text,
    has_passkey    boolean,
    has_consumer_key boolean,
    has_consumer_secret boolean,
    ready          boolean
  )
  language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  return query
  select
    coalesce(c.mpesa_env, 'sandbox')::text,
    c.mpesa_shortcode::text,
    c.callback_url::text,
    coalesce(length(c.mpesa_passkey)         > 0, false),
    coalesce(length(c.mpesa_consumer_key)    > 0, false),
    coalesce(length(c.mpesa_consumer_secret) > 0, false),
    coalesce(
      length(coalesce(c.mpesa_passkey, ''))         > 0
      and length(coalesce(c.mpesa_consumer_key, '')) > 0
      and length(coalesce(c.mpesa_consumer_secret, '')) > 0
      and length(coalesce(c.mpesa_shortcode, ''))   > 0, false)
  from public.isp_payment_configs c
  where c.isp_id = p_isp_id;
end;
$$;

grant execute on function public.payment_config_status(uuid) to authenticated;

-- Writes the configuration. Blank secret inputs are ignored so the UI can save
-- the non-secret fields without ever round-tripping a value it cannot read.
create or replace function public.set_payment_config(
  p_isp_id uuid,
  p_mpesa_env text default null,
  p_shortcode text default null,
  p_callback_url text default null,
  p_passkey text default null,
  p_consumer_key text default null,
  p_consumer_secret text default null
) returns void
  language plpgsql security definer set search_path = public as $$
declare v_isp public.isps;
begin
  perform public.require_super_admin();
  select * into v_isp from public.isps where id = p_isp_id;
  if v_isp.id is null then raise exception 'ISP not found'; end if;

  insert into public.isp_payment_configs (isp_id) values (p_isp_id)
  on conflict (isp_id) do nothing;

  update public.isp_payment_configs set
    mpesa_env             = coalesce(nullif(trim(p_mpesa_env), ''), mpesa_env),
    mpesa_shortcode       = coalesce(nullif(trim(p_shortcode), ''), mpesa_shortcode),
    callback_url          = coalesce(nullif(trim(p_callback_url), ''), callback_url),
    mpesa_passkey         = coalesce(nullif(trim(p_passkey), ''), mpesa_passkey),
    mpesa_consumer_key    = coalesce(nullif(trim(p_consumer_key), ''), mpesa_consumer_key),
    mpesa_consumer_secret = coalesce(nullif(trim(p_consumer_secret), ''), mpesa_consumer_secret),
    updated_at            = now()
  where isp_id = p_isp_id;

  -- An empty shortcode clears the field; anything else updates it
  if p_shortcode is not null and trim(p_shortcode) = '' then
    update public.isp_payment_configs set mpesa_shortcode = null where isp_id = p_isp_id;
  end if;

  insert into public.audit_logs(actor_id, actor_role, isp_id, isp_name,
                                action, target_type, target_id, metadata)
  values (
    auth.uid(), 'super_admin', p_isp_id, v_isp.name,
    'mpesa:configured', 'payment_config', p_isp_id::text,
    jsonb_build_object('env', coalesce(p_mpesa_env, 'unchanged'))
  );
end;
$$;

grant execute on function public.set_payment_config(uuid, text, text, text, text, text, text)
  to authenticated;

-- ── Platform analytics (super admin only) ─────────────────────────────────────
-- Aggregates every tenant into one row per ISP so the dashboard is a single query.
create or replace view public.platform_isp_stats
with (security_invoker = on) as
select
  i.id,
  i.name,
  i.slug,
  i.status,
  i.plan,
  i.country,
  i.county,
  i.city,
  i.brand_color,
  i.max_clients,
  i.max_plans,
  i.trial_ends_at,
  i.created_at,
  (select count(*)::int from public.profiles p
     where p.isp_id = i.id and p.role in ('isp_owner','isp_admin','isp_agent')) as staff_count,
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'active')                        as active_clients,
  (select count(*)::int from public.clients c where c.isp_id = i.id)       as total_clients,
  (select count(*)::int from public.plans pl where pl.isp_id = i.id)       as plan_count,
  (select count(*)::int from public.vouchers v where v.isp_id = i.id)      as voucher_count,
  (select count(*)::int from public.nodes n
     where n.isp_id = i.id and n.status = 'online')                       as nodes_online,
  (select coalesce(sum(pay.amount), 0)::numeric(14,2) from public.payments pay
     where pay.isp_id = i.id and pay.status = 'success')                  as revenue_30d,
  (select coalesce(sum(inv.amount), 0)::numeric(14,2) from public.invoices inv
     where inv.isp_id = i.id and inv.status in ('unpaid','overdue'))       as outstanding,
  (select max(pay.created_at) from public.payments pay
     where pay.isp_id = i.id and pay.status = 'success')                  as last_payment_at
from public.isps i;

-- ── Bulk voucher generation (tenant-scoped, respects plan limits) ─────────────
create or replace function public.generate_vouchers(
  p_isp_id uuid, p_plan_id uuid, p_prefix text, p_count int
) returns setof public.vouchers
  language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_plan public.plans;
  v_max  int;
  i int;
  v_code text;
begin
  if not (public.is_super_admin()
          or (public.current_isp_id() = p_isp_id and public.is_isp_staff())) then
    raise exception 'Not authorised';
  end if;
  if p_count < 1 or p_count > 500 then
    raise exception 'Count must be between 1 and 500';
  end if;

  select * into v_plan from public.plans where id = p_plan_id and isp_id = p_isp_id;
  if v_plan.id is null then raise exception 'Plan not found'; end if;

  -- Starter tiers cap voucher generation
  select case plan when 'starter' then 50 when 'growth' then 500 else 100000 end
    into v_max from public.isps where id = p_isp_id;
  if p_count > v_max then
    raise exception 'Your plan allows a maximum of % vouchers per batch.', v_max;
  end if;

  for i in 1..p_count loop
    v_code := upper(trim(coalesce(p_prefix,'VCH')))
              || '-' || to_char(now(), 'YYMMDD')
              || '-' || upper(substr(md5(random()::text || clock_timestamp()::text || i::text), 1, 5));

    return query
      insert into public.vouchers (isp_id, plan_id, code, batch_prefix, status, expires_at)
      values (v_plan.isp_id, v_plan.id, v_code, upper(coalesce(p_prefix,'VCH')),
              'unused', now() + make_interval(hours => v_plan.duration_hours))
      returning *;
  end loop;
end;
$$;

grant execute on function public.generate_vouchers(uuid, uuid, text, int) to authenticated;

-- ── Voucher redemption (used by the captive portal) ───────────────────────────
create or replace function public.redeem_voucher(p_code text)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_v public.vouchers;
  v_p public.plans;
  v_isp_name text;
begin
  select * into v_v from public.vouchers where lower(code) = lower(trim(p_code));

  if v_v.id is null then
    return jsonb_build_object('success', false, 'message', 'Voucher not found on this platform.');
  end if;

  if v_v.status = 'active' then
    return jsonb_build_object('success', false, 'message', 'This voucher is already in use.');
  end if;
  if v_v.status = 'disabled' then
    return jsonb_build_object('success', false, 'message', 'This voucher has been disabled.');
  end if;
  if v_v.status = 'expired' or (v_v.expires_at is not null and v_v.expires_at < now()) then
    update public.vouchers set status = 'expired' where id = v_v.id;
    return jsonb_build_object('success', false, 'message', 'This voucher has expired.');
  end if;

  select * into v_p from public.plans where id = v_v.plan_id;
  select name into v_isp_name from public.isps where id = v_v.isp_id;

  update public.vouchers
     set status = 'active', activated_at = now(),
         activated_by = coalesce(auth.uid()::text, v_v.activated_by)
   where id = v_v.id;

  insert into public.sessions (isp_id, voucher_code, device_type, mac_address)
  values (v_v.isp_id, v_v.code, 'Captive Portal Login');

  return jsonb_build_object(
    'success', true,
    'message', 'Access granted via ' || coalesce(v_p.name,'voucher'),
    'isp', v_isp_name,
    'plan', jsonb_build_object(
      'name', v_p.name, 'speed', v_p.speed_down,
      'duration', v_p.duration_label, 'dataLimit', v_p.data_limit),
    'expiresAt', v_v.expires_at);
end;
$$;

grant execute on function public.redeem_voucher(text) to anon, authenticated;