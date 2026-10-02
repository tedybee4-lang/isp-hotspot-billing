-- =============================================================================
--  Payment modes
--
--  Many ISPs have a Till number or Paybill but no Safaricom Daraja API access.
--  Three modes are supported:
--
--    manual_till     — no API at all. Customer pays the Till/Paybill via the
--                      M-Pesa app or *334#, then the payment is confirmed.
--                      Requires zero credentials.
--    platform_daraja — the platform operator owns ONE Daraja app; each ISP only
--                      supplies their Till/Paybill shortcode. This is the
--                      recommended setup for multi-tenant.
--    own_daraja      — the ISP supplies their own consumer key/secret/passkey.
-- =============================================================================

do $$ begin create type payment_mode as enum ('manual_till','platform_daraja','own_daraja');
exception when duplicate_object then null; end $$;

-- Platform-wide shared Daraja credentials. Exactly one row.
-- No client SELECT policy: only the service role (stk-push Edge Function) reads
-- it, and super admins read only booleans via payment_config_status().
create table if not exists public.platform_payment_config (
  id                  boolean primary key default true check (id),
  mpesa_env           text not null default 'sandbox' check (mpesa_env in ('sandbox','production')),
  mpesa_passkey       text,
  mpesa_consumer_key  text,
  mpesa_consumer_secret text,
  updated_at          timestamptz not null default now()
);
comment on table public.platform_payment_config is
  'Shared Safaricom Daraja credentials for platform_daraja tenants. Service role only.';

alter table public.isp_payment_configs
  add column if not exists payment_mode    payment_mode not null default 'manual_till',
  add column if not exists till_number     text,
  add column if not exists paybill_number  text,
  add column if not exists customer_notice text;

comment on column public.isp_payment_configs.payment_mode is
  'manual_till = no API needed; platform_daraja = shared operator keys; own_daraja = per-tenant keys';
comment on column public.isp_payment_configs.till_number is
  'M-Pesa Till number the customer pays to in manual_till mode';
comment on column public.isp_payment_configs.paybill_number is
  'Optional Paybill number, shown as an alternative in manual_till mode';
comment on column public.isp_payment_configs.customer_notice is
  'Optional message shown to the customer on the payment instructions screen';

create index if not exists payments_pending_idx
  on public.payments(isp_id, status) where status = 'pending';

-- ── Platform-wide Daraja credentials (super admin writes, service role reads) ──
create or replace function public.platform_payment_status()
  returns table (
    mpesa_env text,
    has_passkey boolean,
    has_consumer_key boolean,
    has_consumer_secret boolean,
    ready boolean
  )
  language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_super_admin();
  return query
  select
    coalesce(p.mpesa_env, 'sandbox')::text,
    coalesce(length(p.mpesa_passkey) > 0, false),
    coalesce(length(p.mpesa_consumer_key) > 0, false),
    coalesce(length(p.mpesa_consumer_secret) > 0, false),
    coalesce(
      length(coalesce(p.mpesa_passkey, '')) > 0
      and length(coalesce(p.mpesa_consumer_key, '')) > 0
      and length(coalesce(p.mpesa_consumer_secret, '')) > 0, false)
  from public.platform_payment_config p
  where p.id = true;
end;
$$;

grant execute on function public.platform_payment_status() to authenticated;

create or replace function public.set_platform_payment_config(
  p_mpesa_env text default null,
  p_passkey text default null,
  p_consumer_key text default null,
  p_consumer_secret text default null
) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform public.require_super_admin();

  insert into public.platform_payment_config (id) values (true)
  on conflict (id) do nothing;

  update public.platform_payment_config set
    mpesa_env             = coalesce(nullif(trim(p_mpesa_env), ''), mpesa_env),
    mpesa_passkey         = coalesce(nullif(trim(p_passkey), ''), mpesa_passkey),
    mpesa_consumer_key    = coalesce(nullif(trim(p_consumer_key), ''), mpesa_consumer_key),
    mpesa_consumer_secret = coalesce(nullif(trim(p_consumer_secret), ''), mpesa_consumer_secret),
    updated_at            = now()
  where id = true;

  insert into public.audit_logs(actor_id, actor_role, action, target_type, metadata)
  values (auth.uid(), 'super_admin', 'mpesa:platform-configured', 'platform_payment_config',
          jsonb_build_object('env', coalesce(p_mpesa_env, 'unchanged')));
end;
$$;

grant execute on function public.set_platform_payment_config(text, text, text, text)
  to authenticated;

-- ── Tenant payment configuration ─────────────────────────────────────────────
-- Mode-aware readiness: manual_till needs no credentials at all.
--
-- The DROP is required: this function gains columns compared to the version in
-- 20260101000200_functions.sql, and PostgreSQL refuses to change a function's
-- return type under CREATE OR REPLACE.
drop function if exists public.payment_config_status(uuid);
create or replace function public.payment_config_status(p_isp_id uuid)
  returns table (
    payment_mode        text,
    mpesa_env           text,
    mpesa_shortcode     text,
    till_number         text,
    paybill_number      text,
    callback_url        text,
    customer_notice     text,
    has_passkey         boolean,
    has_consumer_key    boolean,
    has_consumer_secret boolean,
    platform_ready      boolean,
    ready               boolean
  )
  language plpgsql stable security definer set search_path = public as $$
declare
  v_cfg  public.isp_payment_configs;
  v_plat public.platform_payment_config;
  v_plat_ok boolean;
begin
  perform public.require_super_admin();

  select * into v_cfg  from public.isp_payment_configs where isp_id = p_isp_id;
  select * into v_plat from public.platform_payment_config where id = true;

  v_plat_ok := length(coalesce(v_plat.mpesa_passkey, '')) > 0
           and length(coalesce(v_plat.mpesa_consumer_key, '')) > 0
           and length(coalesce(v_plat.mpesa_consumer_secret, '')) > 0;

  return query select
    coalesce(v_cfg.payment_mode::text, 'manual_till'),
    coalesce(v_cfg.mpesa_env, 'sandbox')::text,
    v_cfg.mpesa_shortcode::text,
    v_cfg.till_number::text,
    v_cfg.paybill_number::text,
    v_cfg.callback_url::text,
    v_cfg.customer_notice::text,
    coalesce(length(v_cfg.mpesa_passkey) > 0, false),
    coalesce(length(v_cfg.mpesa_consumer_key) > 0, false),
    coalesce(length(v_cfg.mpesa_consumer_secret) > 0, false),
    v_plat_ok,
    case coalesce(v_cfg.payment_mode::text, 'manual_till')
      when 'manual_till' then
        (coalesce(v_cfg.till_number, '') <> '' or coalesce(v_cfg.paybill_number, '') <> '')
      when 'platform_daraja' then
        (v_plat_ok and coalesce(v_cfg.mpesa_shortcode, '') <> '')
      else
        (length(coalesce(v_cfg.mpesa_passkey, '')) > 0
         and length(coalesce(v_cfg.mpesa_consumer_key, '')) > 0
         and length(coalesce(v_cfg.mpesa_consumer_secret, '')) > 0
         and coalesce(v_cfg.mpesa_shortcode, '') <> '')
    end;
end;
$$;

grant execute on function public.payment_config_status(uuid) to authenticated;

-- ── Manual Till / Paybill collection (no Daraja API needed) ───────────────────
-- Creates a pending payment and returns everything the customer needs to pay:
-- the Till/Paybill number, the amount, a unique account reference and the
-- USSD/app instructions. The ISP confirms once the money lands.
create or replace function public.start_manual_payment(
  p_invoice_id uuid,
  p_phone text default null
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_inv   public.invoices;
  v_cfg   public.isp_payment_configs;
  v_isp   public.isps;
  v_pay   public.payments;
  v_ref   text;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if v_inv.id is null then raise exception 'Invoice not found'; end if;

  -- Only the owning tenant's staff (or any super admin) may start a payment
  if not (public.is_super_admin()
          or (public.is_isp_staff() and public.current_isp_id() = v_inv.isp_id)) then
    raise exception 'Not authorised';
  end if;

  if v_inv.status = 'paid' then
    raise exception 'This invoice is already paid';
  end if;

  select * into v_cfg from public.isp_payment_configs where isp_id = v_inv.isp_id;
  select * into v_isp from public.isps where id = v_inv.isp_id;

  -- Unique, human-readable reference the customer quotes at the Till.
  -- Max ~10 chars is what the customer sees; the prefix identifies the ISP.
  v_ref := upper(substr(v_isp.slug, 1, 3))
        || '-' || upper(substr(replace(v_inv.invoice_no, '-', ''), -6));

  insert into public.payments
    (isp_id, client_id, invoice_id, phone, amount, method, status)
  values
    (v_inv.isp_id, v_inv.client_id, coalesce(p_phone, ''), v_inv.amount,
     'till_manual', 'pending')
  returning * into v_pay;

  insert into public.audit_logs(actor_id, actor_role, isp_id, isp_name,
                                action, target_type, target_id, metadata)
  values (auth.uid(), case when public.is_super_admin() then 'super_admin'::platform_role else 'isp_admin'::platform_role end,
          v_inv.isp_id, v_isp.name, 'payment:till-issued', 'payment', v_pay.id::text,
          jsonb_build_object('amount', v_inv.amount, 'reference', v_ref));

  return jsonb_build_object(
    'paymentId',    v_pay.id,
    'amount',       v_inv.amount,
    'reference',    v_ref,
    'tillNumber',   v_cfg.till_number,
    'paybillNumber',v_cfg.paybill_number,
    'ispName',      v_isp.name,
    'phone',        p_phone,
    'notice',       v_cfg.customer_notice,
    'instructions', jsonb_build_array(
      'Open M-Pesa → Send Money → To Till Number',
      'Enter the Till number and the exact amount',
      'Use the reference above as the account name',
      'Then tap "I have paid" so we can verify'
    ),
    'message', 'Payment instructions issued. Waiting for confirmation.'
  );
end;
$$;

grant execute on function public.start_manual_payment(uuid, text) to authenticated;

-- Staff confirms the money arrived (checked against the Till statement, or the
-- customer's M-Pesa confirmation SMS). Settles the invoice like a callback.
create or replace function public.confirm_manual_payment(
  p_payment_id uuid,
  p_receipt text default null
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_pay   public.payments;
  v_inv   public.invoices;
  v_isp   public.isps;
  v_client public.clients;
  v_from  timestamptz;
begin
  select * into v_pay from public.payments where id = p_payment_id;
  if v_pay.id is null then raise exception 'Payment not found'; end if;

  if not (public.is_super_admin()
          or (public.is_isp_staff() and public.current_isp_id() = v_pay.isp_id)) then
    raise exception 'Not authorised';
  end if;

  if v_pay.status <> 'pending' then
    raise exception 'This payment is already %', v_pay.status;
  end if;

  update public.payments
     set status = 'success',
         mpesa_receipt = coalesce(p_receipt, mpesa_receipt)
   where id = p_pay.id;

  if v_pay.invoice_id is not null then
    select * into v_inv from public.invoices where id = v_pay.invoice_id;

    update public.invoices set status = 'paid', paid_at = now()
     where id = v_pay.invoice_id;

    if v_inv.client_id is not null then
      select * into v_client from public.clients where id = v_inv.client_id;
      v_from := case
        when v_client.expires_at is not null
             and v_client.expires_at > now() then v_client.expires_at
        else now()
      end;

      update public.clients set
        status = 'active', balance = 0,
        plan_name = coalesce(v_inv.plan_name, plan_name),
        expires_at = v_from + interval '30 days'
      where id = v_inv.client_id;
    end if;
  end if;

  select * into v_isp from public.isps where id = v_pay.isp_id;

  insert into public.audit_logs(actor_id, actor_role, isp_id, isp_name,
                                action, target_type, target_id, metadata)
  values (auth.uid(), case when public.is_super_admin() then 'super_admin'::platform_role else 'isp_admin'::platform_role end,
          v_pay.isp_id, v_isp.name, 'payment:till-confirmed', 'payment', v_pay.id::text,
          jsonb_build_object('amount', v_pay.amount, 'receipt', p_receipt));

  return jsonb_build_object(
    'success', true,
    'message', 'Payment confirmed and the invoice has been marked paid.'
  );
end;
$$;

grant execute on function public.confirm_manual_payment(uuid, text) to authenticated;