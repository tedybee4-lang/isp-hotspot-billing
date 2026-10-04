-- =============================================================================
--  Customer storefront for the captive portal.
--
--  The portal was a voucher box. Packages were fetched but rendered as a
--  read-only price list, and there was no way for a customer to buy one,
--  because the only STK entry point (`hashback-stk`) requires a JWT and a
--  captive-portal visitor never signs in. So the marketplace existed in the
--  database and nowhere else.
--
--  Additive only: no table is dropped and no existing column changes meaning.
--
--  TENANT SAFETY
--  -------------
--  Every public function here is keyed on a SLUG, and the slug is the only
--  thing a browser may supply. The ISP id is always derived from it, so a
--  request cannot be pointed at another tenant: there is no parameter through
--  which to express "and also give me tenant B". This mirrors the existing
--  public_portal_settings / public_portal_packages pair.
--
--  `redeem_voucher(text)` is deliberately NOT reused. It resolves a voucher by
--  code alone, across every tenant, so ISP A's portal could redeem ISP B's
--  voucher. It is left in place because the staff HotSpot preview still calls
--  it, but the public portal uses the scoped version below.
-- =============================================================================

begin;

-- ── 1. Storefront presentation ──────────────────────────────────────────────
--
-- Section toggles default to true: an ISP upgrading should get the full
-- storefront and then turn off what it does not want, rather than have to
-- discover and enable each section.
alter table public.portal_settings
  add column if not exists header_text          text,
  add column if not exists connect_button_text  text not null default 'Click Here To Connect',
  add column if not exists already_paid_text    text not null default 'Already Paid? Click Here.',
  add column if not exists packages_heading     text not null default 'AVAILABLE INTERNET PACKAGES',
  add column if not exists popular_label        text not null default 'MOST POPULAR',
  add column if not exists currency_label       text not null default 'KES',
  -- Explicit display order. Empty means "cheapest first", which is what the
  -- portal did before this column existed.
  add column if not exists package_order        uuid[] not null default '{}',
  -- The package carrying the "MOST POPULAR" badge. Distinct from
  -- plans.is_popular, which is the same idea catalogue-wide.
  add column if not exists featured_plan_id     uuid references public.plans(id) on delete set null,
  add column if not exists show_voucher         boolean not null default true,
  add column if not exists show_login           boolean not null default true,
  add column if not exists show_reconnect       boolean not null default true,
  add column if not exists show_contact         boolean not null default true,
  add column if not exists show_social          boolean not null default true,
  add column if not exists show_quick_links     boolean not null default true,
  add column if not exists show_mac             boolean not null default true,
  add column if not exists quick_links          jsonb not null default '{}'::jsonb;
-- ── 2. Public portal settings, extended ─────────────────────────────────────
--
-- Replaced rather than edited so the allow-list stays in one readable place.
-- It is still an allow-list: no column can be coerced out of this projection,
-- and no id is accepted as a parameter.
create or replace function public.public_portal_settings(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'portal_name',          s.portal_name,
    'welcome_message',      s.welcome_message,
    'terms_conditions',     s.terms_conditions,
    'support_email',        s.support_email,
    'support_phone',        s.support_phone,
    'support_whatsapp',     s.support_whatsapp,
    'logo_url',             coalesce(nullif(s.logo_url, ''), i.logo_url),
    'favicon_url',          s.favicon_url,
    'background_url',       s.background_url,
    'background_color',     s.background_color,
    'primary_color',        s.primary_color,
    'accent_color',         s.accent_color,
    'login_method',         s.login_method,
    'show_packages',        s.show_packages,
    'package_ids',          s.package_ids,
    'payment_instructions', s.payment_instructions,
    'footer_text',          s.footer_text,
    'social_links',         s.social_links,
    'hide_routeros',        s.hide_routeros,
    'show_usage',           s.show_usage,
    'is_enabled',           s.is_enabled,
    -- Storefront
    'header_text',          s.header_text,
    'connect_button_text',  s.connect_button_text,
    'already_paid_text',    s.already_paid_text,
    'packages_heading',     s.packages_heading,
    'popular_label',        s.popular_label,
    'currency_label',       s.currency_label,
    'package_order',        s.package_order,
    'featured_plan_id',     s.featured_plan_id,
    'show_voucher',         s.show_voucher,
    'show_login',           s.show_login,
    'show_reconnect',       s.show_reconnect,
    'show_contact',         s.show_contact,
    'show_social',          s.show_social,
    'show_quick_links',     s.show_quick_links,
    'show_mac',             s.show_mac,
    'quick_links',          s.quick_links,
    -- Denormalised so the portal needs only this one call.
    'isp_name',    i.name,
    'isp_slug',    i.slug,
    'brand_color', i.brand_color,
    'contact_email', i.contact_email,
    'contact_phone', i.contact_phone
  )
  from public.portal_settings s
  join public.isps i on i.id = s.isp_id
  where i.slug = lower(trim(p_slug));
$$;

grant execute on function public.public_portal_settings(text) to anon, authenticated;

-- ── 3. Public portal packages, with ISP-defined order and badges ────────────
--
-- Ordering moved from "cheapest first" to the ISP's own sequence. A package
-- listed in package_order sorts at its listed index; anything unlisted sorts
-- after everything listed, cheapest first among itself, so adding a package
-- to the catalogue never silently reshuffles a curated list.
create or replace function public.public_portal_packages(p_slug text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.sort_key, p.price asc), '[]'::jsonb)
  from (
    select
      pl.id, pl.name, pl.kind, pl.duration_label, pl.duration_hours,
      pl.price, pl.speed_down, pl.speed_up, pl.data_limit, pl.fup,
      pl.description, pl.is_popular,
      -- The badge. An explicit choice by the ISP always wins and is the ONLY
      -- source of it: falling back to plans.is_popular here would paint a badge
      -- on every flagged plan, and the seeded catalogues flag two, so the
      -- storefront would advertise two "MOST POPULAR" packages at once. A badge
      -- the customer cannot trust is worse than no badge. With nothing chosen,
      -- no package is featured.
      (pl.id = ps.featured_plan_id) as is_featured,
      coalesce(array_position(ps.package_order, pl.id), 1000000) as sort_key
    from public.plans pl
    join public.isps i on i.id = pl.isp_id
    join public.portal_settings ps on ps.isp_id = i.id
    where i.slug = lower(trim(p_slug))
      -- Only an ISP that has switched its portal on exposes prices.
      and ps.is_enabled
      and pl.is_active
      and pl.show_on_portal
      -- If the ISP curated a package list, honour it; otherwise show every
      -- active portal-visible package.
      and (pl.id = any (coalesce(ps.package_ids, '{}'::uuid[]))
           or ps.package_ids is null
           or cardinality(ps.package_ids) = 0)
  ) p;
$$;

grant execute on function public.public_portal_packages(text) to anon, authenticated;

comment on column public.portal_settings.package_order is
  'Display order for the portal package grid. Empty = cheapest first.';
comment on column public.portal_settings.quick_links is
  'Footer navigation, e.g. {"about":"https://...","faq":"https://..."}. Only keys with a value are rendered.';
-- ── 4. Voucher redemption, scoped to the portal's tenant ────────────────────
--
-- Throttled by failure count. A voucher code is a bearer credential, and an
-- unthrottled public redemption endpoint is a code oracle: 62^n guesses at no
-- cost. Failures are counted per tenant AND per code, so a noisy or hostile
-- caller locks out their own tenant's guessing rather than everyone's.
create table if not exists public.portal_voucher_throttle (
  isp_id        uuid not null references public.isps(id) on delete cascade,
  code_hash     text not null,
  failures      integer not null default 0,
  blocked_until timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (isp_id, code_hash)
);

comment on table public.portal_voucher_throttle is
  'Failed public voucher redemption attempts, per tenant and per code hash. '
  'Caps offline guessing of a bearer credential. No plaintext code is stored.';

alter table public.portal_voucher_throttle enable row level security;
revoke all on public.portal_voucher_throttle from anon, authenticated;
grant all on public.portal_voucher_throttle to service_role;

create or replace function public.portal_redeem_voucher(
  p_slug  text,
  p_code  text,
  p_phone text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp   uuid;
  v_v     public.vouchers;
  v_p     public.plans;
  v_hash  text;
  v_thr   public.portal_voucher_throttle;
  v_limit constant integer := 8;
begin
  select id into v_isp from public.isps where slug = lower(trim(p_slug));
  if v_isp is null then
    return jsonb_build_object('success', false, 'message', 'Portal not found.');
  end if;

  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('success', false, 'message', 'Enter your voucher code.');
  end if;

  -- Schema-qualified: Supabase installs pgcrypto into `extensions`, and a SECURITY
  -- DEFINER function's search_path does not reliably include it.
  v_hash := encode(extensions.digest(lower(btrim(p_code)), 'sha256'), 'hex');

  select * into v_thr from public.portal_voucher_throttle
   where isp_id = v_isp and code_hash = v_hash
   for update;

  if v_thr.isp_id is not null and v_thr.blocked_until is not null
     and v_thr.blocked_until > now() then
    return jsonb_build_object('success', false,
      'message', 'Too many incorrect attempts. Try again in a few minutes.');
  end if;

  -- Scoped to this tenant. A code belonging to another ISP simply does not
  -- exist as far as this portal is concerned, which is what stops cross-tenant
  -- redemption.
  select * into v_v from public.vouchers
   where lower(code) = lower(btrim(p_code)) and isp_id = v_isp;

  -- Unknown, used, disabled and expired all fall through to ONE response.
  -- Distinguishing them would turn this endpoint into an oracle for which codes
  -- exist and which are already spent.
  if v_v.id is null or v_v.status <> 'unused'
     or (v_v.expires_at is not null and v_v.expires_at < now()) then

    insert into public.portal_voucher_throttle (isp_id, code_hash, failures, blocked_until, updated_at)
    values (v_isp, v_hash, 1,
            case when coalesce(v_thr.failures, 0) + 1 >= v_limit
                 then now() + interval '10 minutes' end,
            now())
    on conflict (isp_id, code_hash) do update
      set failures = public.portal_voucher_throttle.failures + 1,
          blocked_until = case
            when public.portal_voucher_throttle.failures + 1 >= v_limit
              then now() + interval '10 minutes'
            else public.portal_voucher_throttle.blocked_until
          end,
          updated_at = now();

    return jsonb_build_object('success', false,
      'message', 'That voucher code is not valid on this network.');
  end if;

  -- Valid. Clear the throttle, so a customer who fat-fingers their own code is
  -- not locked out for the next ten minutes.
  delete from public.portal_voucher_throttle
   where isp_id = v_isp and code_hash = v_hash;

  select * into v_p from public.plans where id = v_v.plan_id;

  update public.vouchers
     set status = 'active', activated_at = now()
   where id = v_v.id;

  insert into public.sessions (isp_id, voucher_code, device_type)
  values (v_v.isp_id, v_v.code, 'Captive Portal Login');

  return jsonb_build_object(
    'success', true,
    'message', 'You are online. ' || coalesce(v_p.name, 'Access granted') || ' is active.',
    'plan', jsonb_build_object(
      'name', v_p.name, 'speed', v_p.speed_down,
      'duration', v_p.duration_label, 'dataLimit', v_p.data_limit),
    'expiresAt', v_v.expires_at);
end;
$$;

grant execute on function public.portal_redeem_voucher(text, text, text) to anon, authenticated;
-- ── 5. Server-priced payment creation ───────────────────────────────────────
--
-- This is what makes "Click Here To Connect" real.
--
-- The browser supplies a SLUG, a PLAN ID and a PHONE NUMBER. It cannot supply
-- an amount, an ISP id or a HashBack AccountID, because no parameter exists
-- for any of them. The price comes from the plan row, the tenant from the
-- slug, and the AccountID from that tenant's own channel configuration.
--
-- SERVICE ROLE ONLY. The AccountID is in the return value and must never reach
-- a browser; the Edge Function holding the service key is the only caller that
-- should see it.
--
-- It also creates the INVOICE, deliberately. Settlement activates a customer by
-- walking payment -> invoice -> client, so a portal purchase that created only
-- a payment row would settle as "success" and grant nothing: a payment that
-- looks like it worked and silently delivers no service.
create or replace function public.portal_create_payment(
  p_slug    text,
  p_plan_id uuid,
  p_msisdn  text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp    uuid;
  v_plan   public.plans;
  v_cfg    public.isp_payment_configs;
  v_client public.clients;
  v_inv    public.invoices;
  v_pay    public.payments;
  v_ref    text;
  v_amount numeric(12,2);
  v_phone  text;
begin
  select id into v_isp from public.isps where slug = lower(trim(p_slug));
  if v_isp is null then
    raise exception 'Portal not found' using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from public.portal_settings
                  where isp_id = v_isp and is_enabled) then
    raise exception 'This portal is not accepting payments'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- The authoritative amount. Scoped to the tenant, and refused rather than
  -- defaulted: a fallback price is how "pay KSh 1 for a KSh 1,500 package"
  -- happens.
  select * into v_plan from public.plans
   where id = p_plan_id and isp_id = v_isp and is_active and show_on_portal;

  if v_plan.id is null then
    raise exception 'Package not found' using errcode = 'no_data_found';
  end if;

  v_amount := v_plan.price;
  if v_amount is null or v_amount <= 0 then
    raise exception 'That package has no valid price'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- The tenant's own channel. Never a parameter.
  select * into v_cfg from public.isp_payment_configs where isp_id = v_isp;
  if v_cfg.payment_provider::text <> 'hashback'
     or v_cfg.connection_status::text <> 'connected'
     or v_cfg.hashback_account_id is null then
    raise exception 'This network is not ready to accept payments yet'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Digits only, Kenyan shape. The Edge Function normalises for the provider;
  -- this keeps junk out of the customer record.
  v_phone := regexp_replace(coalesce(p_msisdn, ''), '\D', '', 'g');
  if v_phone !~ '^254\d{9}$' and v_phone !~ '^0\d{9}$' then
    raise exception 'Enter a valid Kenyan phone number, for example 0712345678'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_phone like '0%' then
    v_phone := '254' || substr(v_phone, 2);
  end if;

  -- Identify the payer. Reuse an existing customer on this phone so a repeat
  -- buyer accumulates time on one account instead of accumulating duplicate
  -- rows, and so the RADIUS mirror keys on one client_id.
  select * into v_client from public.clients
   where isp_id = v_isp and regexp_replace(phone, '\D', '', 'g') = v_phone
   order by created_at
   limit 1;

  if v_client.id is null then
    insert into public.clients
      (isp_id, account_no, full_name, phone, status, plan_name)
    values (
      v_isp,
      'M' || to_char(now(), 'YYMM') || '-' || upper(substr(md5(random()::text), 1, 6)),
      'M-Pesa customer',
      v_phone,
      'pending',
      v_plan.name)
    returning * into v_client;
  end if;

  insert into public.invoices (
    isp_id, client_id, invoice_no, period_label, plan_name,
    amount, due_date, status
  ) values (
    v_isp, v_client.id,
    'PORTAL-' || upper(substr(md5(random()::text), 1, 10)),
    v_plan.duration_label, v_plan.name,
    v_amount, current_date, 'unpaid'
  ) returning * into v_inv;

  -- Unique, opaque, derived from a UUID and nothing secret.
  v_ref := 'NETISP-' || replace(extensions.gen_random_uuid()::text, '-', '');

  insert into public.payments (
    isp_id, client_id, invoice_id, phone, amount, method, status,
    payment_provider, provider_reference, initiated_at, provider_metadata
  ) values (
    v_isp, v_client.id, v_inv.id, v_phone, v_amount, 'mpesa', 'pending',
    'hashback', v_ref, now(),
    jsonb_build_object('plan_id', v_plan.id,
                       'plan_name', v_plan.name,
                       'source', 'captive_portal',
                       'isp_slug', lower(trim(p_slug)))
  ) returning * into v_pay;

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_pay.id,
    'reference', v_ref,
    'amount', v_amount,
    'currency', 'KES',
    'isp_id', v_isp,
    'plan_name', v_plan.name,
    'duration_label', v_plan.duration_label,
    'duration_hours', v_plan.duration_hours,
    -- Server-side only. Never returned to a browser.
    'hashback_account_id', v_cfg.hashback_account_id
  );
end;
$$;

revoke all on function public.portal_create_payment(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_create_payment(text, uuid, text) to service_role;

comment on function public.portal_create_payment(text, uuid, text) is
  'Creates a pending captive-portal payment. Amount, tenant and HashBack '
  'AccountID are resolved from the slug and the plan row; none is accepted '
  'from the caller. Also creates the invoice, because settlement activates '
  'service by walking payment -> invoice -> client.';
-- ── 6. Payment status, for the anonymous waiting screen ─────────────────────
--
-- Scoped by BOTH slug and reference. The reference alone is unguessable, but
-- pairing them means ISP A's portal cannot ask about ISP B's payment at all.
--
-- Returns the minimum the waiting screen needs, and nothing that identifies the
-- payer. It reports settlement; it never settles anything.
create or replace function public.portal_payment_status(
  p_slug      text,
  p_reference text
) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'found', true,
    'status', pay.status::text,
    'amount', pay.amount,
    'plan',   pay.provider_metadata->>'plan_name',
    'message', case pay.status::text
                 when 'success'  then 'Payment received. Your package is being activated now.'
                 when 'failed'   then 'That payment did not go through. Please try again.'
                 when 'reversed' then 'That payment was reversed.'
                 else 'Waiting for your M-Pesa confirmation...'
               end
  )
  from public.payments pay
  join public.isps i on i.id = pay.isp_id
  where i.slug = lower(trim(p_slug))
    and pay.provider_reference = p_reference;
$$;

grant execute on function public.portal_payment_status(text, text) to anon, authenticated;

-- ── 7. Customer login, scoped to this portal's tenant ───────────────────────
--
-- Username is unique per (isp_id, username), not globally, so the lookup is
-- scoped by the slug's tenant. An unscoped lookup could authenticate the right
-- password against the wrong ISP.
--
-- The password is compared in the database against the same encrypted store
-- RADIUS authenticates against. It is never returned, logged, or selected into
-- the response, and because this is SECURITY DEFINER, `anon` never needs read
-- access to the ciphertext.
--
-- Unknown user and wrong password return the SAME message and take the same
-- path, so the endpoint is not a username oracle.
create or replace function public.portal_customer_login(
  p_slug     text,
  p_username text,
  p_password text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp   uuid;
  v_acct  public.service_accounts;
  v_clear text;
  v_ok    boolean := false;
begin
  select id into v_isp from public.isps where slug = lower(trim(p_slug));
  if v_isp is null then
    return jsonb_build_object('ok', false, 'message', 'Portal not found.');
  end if;

  if p_username is null or btrim(p_username) = ''
     or p_password is null or p_password = '' then
    return jsonb_build_object('ok', false,
      'message', 'Enter your username and password.');
  end if;

  select * into v_acct from public.service_accounts
   where isp_id = v_isp and lower(username) = lower(btrim(p_username));

  -- radius_cleartext_password already returns NULL for an unknown subscriber,
  -- an unprovisioned password, or any decryption failure, so a customer the
  -- portal cannot authenticate is a rejection rather than a bypass.
  if v_acct.id is not null then
    v_clear := public.radius_cleartext_password(v_acct.username, v_isp);
    if v_clear is not null and length(v_clear) = length(p_password) then
      v_ok := v_clear = p_password;
    end if;
  end if;

  if not v_ok then
    return jsonb_build_object('ok', false,
      'message', 'Those details did not match an active account.');
  end if;

  if v_acct.status <> 'active'
     or (v_acct.expires_at is not null and v_acct.expires_at < now()) then
    return jsonb_build_object('ok', false, 'message',
      'That account is not active. Buy a package or activate a voucher to reconnect.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'username', v_acct.username,
    'expires_at', v_acct.expires_at,
    'message', 'Signed in. You can reconnect from your device now.');
end;
$$;

grant execute on function public.portal_customer_login(text, text, text) to anon, authenticated;
-- ── 8. Reconnect / troubleshoot ─────────────────────────────────────────────
--
-- "My internet died and I do not want to pay again."
--
-- The only genuinely useful thing the platform can do is notice a session the
-- router has stopped accounting for and release it, because a stale RADIUS
-- session holds the customer's own concurrency slot.
--
-- Only STALE sessions are touched: one with no accounting update for longer
-- than the tenant's idle timeout. A live session is reported as live and left
-- alone. That bound matters because this endpoint is anonymous - without it,
-- naming a username would let anyone disconnect any customer of that ISP at
-- will, which is a denial-of-service primitive.
create or replace function public.portal_reconnect(
  p_slug     text,
  p_username text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp    uuid;
  v_idle   integer := 5;
  v_sess   public.radius_sessions;
  v_node   uuid;
  v_job    uuid;
  v_cutoff timestamptz;
begin
  select id into v_isp from public.isps where slug = lower(trim(p_slug));
  if v_isp is null then
    return jsonb_build_object('ok', false, 'message', 'Portal not found.');
  end if;

  if p_username is null or btrim(p_username) = '' then
    return jsonb_build_object('ok', false, 'message', 'Enter your username.');
  end if;

  select coalesce(idle_timeout_min, 5) into v_idle
    from public.network_settings where isp_id = v_isp;

  v_cutoff := now() - make_interval(mins => greatest(coalesce(v_idle, 5), 5));

  select * into v_sess from public.radius_sessions
   where isp_id = v_isp
     and lower(username) = lower(btrim(p_username))
     and ended_at is null
   order by last_update desc
   limit 1;

  if v_sess.id is null then
    return jsonb_build_object(
      'ok', true, 'action', 'none', 'reconnected', false,
      'message', 'No active session was found for that username. '
                  || 'Connect using your account details.');
  end if;

  if v_sess.last_update >= v_cutoff then
    -- Still reporting. Nothing is wrong with it, so nothing is done to it.
    return jsonb_build_object(
      'ok', true, 'action', 'none', 'reconnected', false, 'live', true,
      'started_at', v_sess.started_at,
      'message', 'Your session is still active. Turn Wi-Fi off and on if your internet is not working.');
  end if;

  -- Stale: the router stopped sending accounting. Release the slot.
  select id into v_node from public.nodes
   where isp_id = v_isp and enabled order by created_at limit 1;

  if v_node is not null then
    insert into public.router_jobs
      (isp_id, node_id, kind, payload, idempotency_key, priority, max_attempts)
    values (
      v_isp, v_node, 'disconnect',
      jsonb_build_object('session_id', v_sess.id,
                         'username', v_sess.username,
                         'mac_address', v_sess.called_station_id,
                         'reason', 'customer requested reconnect'),
      'reconnect:' || v_sess.id::text, 1, 3
    )
    on conflict do nothing
    returning id into v_job;
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', case when v_job is not null then 'disconnect_queued' else 'no_router' end,
    'reconnected', false,
    'message', case
      when v_job is not null then
        'Your old session was stuck. We have released it - reconnect now with your account details.'
      else
        'Your old session was stuck but this network has no router to release it. '
        || 'Turn Wi-Fi off and on, or contact support.'
    end);
end;
$$;

grant execute on function public.portal_reconnect(text, text) to anon, authenticated;
-- ── 9. Persist the storefront fields ────────────────────────────────────────
--
-- save_portal_settings writes every column explicitly, so an unexpected key in
-- p_patch can never reach a column that does not exist. The storefront columns
-- follow the same rule.
create or replace function public.save_portal_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_isp uuid := public.current_isp_id();
  v_row public.portal_settings;
begin
  if v_isp is null then raise exception 'No ISP in scope'; end if;
  if not (public.is_super_admin() or public.can_manage_isp()) then
    raise exception 'Insufficient permissions';
  end if;

  insert into public.portal_settings (isp_id) values (v_isp)
  on conflict (isp_id) do nothing;

  update public.portal_settings t set
    is_enabled           = coalesce((p_patch->>'is_enabled')::boolean, t.is_enabled),
    portal_name          = case when p_patch ? 'portal_name' then p_patch->>'portal_name' else t.portal_name end,
    welcome_message      = case when p_patch ? 'welcome_message' then p_patch->>'welcome_message' else t.welcome_message end,
    terms_conditions     = case when p_patch ? 'terms_conditions' then p_patch->>'terms_conditions' else t.terms_conditions end,
    support_email        = case when p_patch ? 'support_email' then p_patch->>'support_email' else t.support_email end,
    support_phone        = case when p_patch ? 'support_phone' then p_patch->>'support_phone' else t.support_phone end,
    support_whatsapp     = case when p_patch ? 'support_whatsapp' then p_patch->>'support_whatsapp' else t.support_whatsapp end,
    logo_url             = case when p_patch ? 'logo_url' then p_patch->>'logo_url' else t.logo_url end,
    favicon_url          = case when p_patch ? 'favicon_url' then p_patch->>'favicon_url' else t.favicon_url end,
    background_url       = case when p_patch ? 'background_url' then p_patch->>'background_url' else t.background_url end,
    background_color     = case when p_patch ? 'background_color' then p_patch->>'background_color' else t.background_color end,
    primary_color        = case when p_patch ? 'primary_color' then p_patch->>'primary_color' else t.primary_color end,
    accent_color         = case when p_patch ? 'accent_color' then p_patch->>'accent_color' else t.accent_color end,
    login_method         = coalesce(p_patch->>'login_method', t.login_method),
    show_packages        = coalesce((p_patch->>'show_packages')::boolean, t.show_packages),
    package_ids          = case
                              when p_patch ? 'package_ids' and jsonb_typeof(p_patch->'package_ids') = 'array'
                                then array(select x::text::uuid
                                          from jsonb_array_elements_text(p_patch->'package_ids') as x)
                              else t.package_ids
                            end,
    payment_instructions = case when p_patch ? 'payment_instructions' then p_patch->>'payment_instructions' else t.payment_instructions end,
    footer_text          = case when p_patch ? 'footer_text' then p_patch->>'footer_text' else t.footer_text end,
    social_links         = coalesce(p_patch->'social_links', t.social_links),
    hide_routeros        = coalesce((p_patch->>'hide_routeros')::boolean, t.hide_routeros),
    show_usage           = coalesce((p_patch->>'show_usage')::boolean, t.show_usage),

    -- Storefront
    header_text          = case when p_patch ? 'header_text' then p_patch->>'header_text' else t.header_text end,
    connect_button_text  = case when p_patch ? 'connect_button_text' then p_patch->>'connect_button_text' else t.connect_button_text end,
    already_paid_text    = case when p_patch ? 'already_paid_text' then p_patch->>'already_paid_text' else t.already_paid_text end,
    packages_heading     = case when p_patch ? 'packages_heading' then p_patch->>'packages_heading' else t.packages_heading end,
    popular_label        = case when p_patch ? 'popular_label' then p_patch->>'popular_label' else t.popular_label end,
    currency_label       = case when p_patch ? 'currency_label' then p_patch->>'currency_label' else t.currency_label end,
    package_order        = case
                              when p_patch ? 'package_order' and jsonb_typeof(p_patch->'package_order') = 'array'
                                then array(select x::text::uuid
                                          from jsonb_array_elements_text(p_patch->'package_order') as x)
                              else t.package_order
                            end,
    featured_plan_id     = case
                              when p_patch ? 'featured_plan_id' and coalesce(p_patch->>'featured_plan_id', '') = ''
                                then null
                              when p_patch ? 'featured_plan_id'
                                then (p_patch->>'featured_plan_id')::uuid
                              else t.featured_plan_id
                            end,
    show_voucher         = coalesce((p_patch->>'show_voucher')::boolean, t.show_voucher),
    show_login           = coalesce((p_patch->>'show_login')::boolean, t.show_login),
    show_reconnect       = coalesce((p_patch->>'show_reconnect')::boolean, t.show_reconnect),
    show_contact         = coalesce((p_patch->>'show_contact')::boolean, t.show_contact),
    show_social          = coalesce((p_patch->>'show_social')::boolean, t.show_social),
    show_quick_links     = coalesce((p_patch->>'show_quick_links')::boolean, t.show_quick_links),
    show_mac             = coalesce((p_patch->>'show_mac')::boolean, t.show_mac),
    quick_links          = coalesce(p_patch->'quick_links', t.quick_links),

    updated_at           = now(),
    updated_by           = auth.uid()
  where t.isp_id = v_isp
  returning * into v_row;

  perform public.log_isp_action('portal:updated', 'portal_settings', v_isp::text,
                                jsonb_build_object('isp_id', v_isp));
  return to_jsonb(v_row);
end;
$$;

grant execute on function public.save_portal_settings(jsonb) to authenticated;

commit;
