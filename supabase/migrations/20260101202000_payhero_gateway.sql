-- =============================================================================
--  PayHero gateway.
--
--  Wires the verified PayHero adapter (_shared/payhero.ts) into the real payment
--  flow. Everything here is ADDITIVE: no table is dropped, no row is deleted, no
--  historical payment is rewritten. The database is not reset.
--
--  WHAT PAYHERO ACTUALLY SUPPORTS (verified against docs.payhero.co.ke)
--  -----------------------------------------------------------------
--  PayHero has NO OAuth, no Connect App and no delegated authorization. Its only
--  documented scheme is `Authorization: Basic <token>`. So there is no account
--  login to automate, and no token-refresh lifecycle to build. What IS officially
--  supported, and what this migration wires, is:
--
--    * STK push              POST /api/v2/payments
--    * channel discovery     GET  /api/v2/payment_channels
--    * wallet / balance      GET  /api/v2/wallets
--    * transaction status    GET  /api/v2/transaction-status   <- verification
--
--  PayHero documents NO webhook signature (no HMAC, no shared secret). The only
--  integrity available is the Basic credential on an outbound verification call,
--  so this design treats every inbound callback as UNVERIFIED until
--  transaction-status confirms it. That is a security decision, not a gap.
--
--  DESIGN: WHY SETTLEMENT REUSES THE HASHBACK FUNCTION
--  ---------------------------------------------------
--  settle_hashback_payment() already does the money-critical work correctly:
--  FOR UPDATE serialisation, conflict-before-duplicate ordering, the duplicate
--  short-circuit, invoice marking, plan-resolved activation periods, and the
--  RADIUS + SMS completion — all in one transaction.
--
--  That logic is provider-agnostic despite its name: it keys off
--  `provider_reference`, which PayHero payments also carry. Reimplementing it
--  would create a second settlement path that must be kept bug-for-bug in sync
--  with the first — the classic way a payments system starts double-renewing.
--  So PayHero calls the SAME function. Only the provider label written into the
--  reconciliation and audit rows differs, and that is passed in explicitly.
-- =============================================================================

begin;

-- ── 1. Platform-wide PayHero credential storage ─────────────────────────────
--
-- One row, like the HashBack row. The Basic token is stored as AES-GCM
-- ciphertext under its own domain key (PAYHERO_CREDENTIALS_KEY), so a leaked
-- dump yields no usable credential and a compromise of the HashBack key does not
-- decrypt PayHero.
--
-- There is no client SELECT policy on this table, so the browser cannot read the
-- ciphertext even with the anon key. The service role reads it and decrypts it.
alter table public.platform_payment_config
  add column if not exists payhero_api_token_ciphertext text,
  add column if not exists payhero_account_id      bigint,
  add column if not exists payhero_connection_status text
    check (payhero_connection_status in ('unconfigured','configured','verified','failed')),
  add column if not exists payhero_last_verified_at timestamptz,
  add column if not exists payhero_last_error       text,
  add column if not exists payhero_balance          numeric(14,2),
  add column if not exists payhero_currency         text,
  add column if not exists payhero_channels         jsonb,
  add column if not exists payhero_callback_url     text;

comment on column public.platform_payment_config.payhero_api_token_ciphertext is
  'AES-GCM ciphertext of the PayHero Basic auth token. Service role only. Never returned to a browser.';
comment on column public.platform_payment_config.payhero_channels is
  'Last verified snapshot of PayHero payment channels. Discovery cache only; the live source is the PayHero API.';

-- ── 2. Per-tenant PayHero channel ────────────────────────────────────────────
--
-- PayHero addresses an STK push to a `channel_id` (a Till or PayBill registered
-- on the account). That is the exact analogue of HashBack's `hashback_account_id`,
-- so the same column role is reused rather than a parallel table: the existing
-- unique index, RLS policies and tenant lookups all keep working unchanged.
--
-- `payhero_channel_id` is an identifier, NOT a credential. It cannot authorise an
-- API call, so it is safe to display and is returned to the ISP's own admin.
alter table public.isp_payment_configs
  add column if not exists payhero_channel_id     bigint,
  add column if not exists payhero_channel_label  text;

comment on column public.isp_payment_configs.payhero_channel_id is
  'PayHero payment channel (Till/PayBill) id this ISP collects through. An identifier, not a credential.';

-- One channel may back only one ISP. Without this, two tenants could point at the
-- same Till and each settlement would activate the wrong customer.
create unique index if not exists isp_payment_configs_payhero_channel_uniq
  on public.isp_payment_configs (payhero_channel_id)
  where payhero_channel_id is not null;
-- ── 3. Provider-agnostic settlement ──────────────────────────────────────────
--
-- settle_hashback_payment() and fail_hashback_payment() are reused as-is for
-- PayHero. Only this small wrapper exists, to stamp the correct provider label
-- into the audit record that those functions write.
--
-- It is a THIN wrapper, not a reimplementation: all ordering, idempotency and
-- activation behaviour stays inside the function it calls.
create or replace function public.settle_payhero_payment(
  p_reference          text,
  p_transaction_id     text default null,
  p_receipt            text default null,
  p_msisdn             text default null,
  p_amount             numeric default null,
  p_channel_id         bigint default null,
  p_provider_metadata  jsonb default '{}'::jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_result jsonb;
  v_payment_id uuid;
begin
  -- Delegate first. Nothing is written by this wrapper until the shared function
  -- has decided, so the wrapper cannot settle a payment the shared logic refuses.
  v_result := public.settle_hashback_payment(
    p_reference, p_transaction_id, p_receipt,
    null, null,                       -- checkout/merchant ids are HashBack-shaped
    p_msisdn, p_amount,
    case when p_channel_id is null then null else p_channel_id::text end,
    p_provider_metadata
  );

  v_payment_id := nullif(v_result->>'payment_id', '')::uuid;

  -- Correct the provider label on the audit row the shared function just wrote.
  -- Bounded to this one payment's success record, so a real HashBack payment is
  -- never relabelled.
  if v_payment_id is not null and v_result->>'settled' = 'true' then
    update public.audit_logs
       set metadata = metadata || jsonb_build_object('provider', 'payhero')
     where target_type = 'payment'
       and target_id = v_payment_id::text
       and action = 'payment:success';
  end if;

  return v_result || jsonb_build_object('provider', 'payhero');
end;
$$;

revoke all on function public.settle_payhero_payment(text, text, text, text, numeric, bigint, jsonb) from public;
grant execute on function public.settle_payhero_payment(text, text, text, text, numeric, bigint, jsonb) to service_role;

-- The failure path needs no wrapper: fail_hashback_payment() writes the provider
-- literal 'hashback' into a reconciliation row only when the reference is
-- UNKNOWN, and an unknown reference is by definition not a PayHero payment this
-- tenant owns. For known references it updates the payment row and writes no
-- provider label at all. PayHero reuses it directly.
-- ── 4. PayHero payment initiation ───────────────────────────────────────────
--
-- Mirrors create_hashback_payment(), with two differences that matter:
--
--   * it requires `payhero_channel_id` instead of `hashback_account_id`, because
--     that is what PayHero's STK endpoint actually addresses;
--   * the amount STILL comes from resolve_chargeable(), exactly as for HashBack.
--     This is the guarantee that a browser cannot choose what it pays. Nothing in
--     this function accepts an amount as a parameter.
--
-- The reference prefix is distinct ('ISPFLOW-') so a PayHero payment can never be
-- confused with a HashBack one, and so the callback can tell which provider's
-- pipeline a reference belongs to before touching anything.
create or replace function public.create_payhero_payment(
  p_invoice_id uuid default null,
  p_client_id  uuid default null,
  p_plan_id    uuid default null,
  p_msisdn     text default null
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_charge jsonb;
  v_cfg    public.isp_payment_configs;
  v_ref    text;
  v_pay    public.payments;
begin
  v_charge := public.resolve_chargeable(p_invoice_id, p_client_id, p_plan_id);

  select * into v_cfg from public.isp_payment_configs
   where isp_id = (v_charge->>'isp_id')::uuid;

  -- Refuse to create a payment that could never settle. Better to say so now than
  -- to collect money against a channel the STK call will reject.
  if v_cfg.payment_provider <> 'payhero' then
    raise exception 'This ISP is not configured for PayHero payments'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_cfg.connection_status <> 'connected' or v_cfg.payhero_channel_id is null then
    raise exception 'This ISP payment channel is not connected yet'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Unique and opaque, derived only from the row id — never from a secret.
  v_ref := 'ISPFLOW-' || replace(p_gen_random_uuid()::text, '-', '');

  insert into public.payments (
    isp_id, client_id, invoice_id, phone, amount, method, status,
    payment_provider, provider_reference, initiated_at, provider_metadata
  ) values (
    (v_charge->>'isp_id')::uuid,
    (v_charge->>'client_id')::uuid,
    p_invoice_id,
    p_msisdn,
    (v_charge->>'amount')::numeric,
    'mpesa',
    'pending',
    'payhero',
    v_ref,
    now(),
    jsonb_build_object('plan_id', v_charge->'plan_id', 'plan_name', v_charge->'plan_name',
                       'payhero_channel_id', v_cfg.payhero_channel_id)
  ) returning * into v_pay;

  insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, target_id, metadata)
  values (auth.uid(),
          case when public.is_super_admin() then 'super_admin'::platform_role
               else 'isp_admin'::platform_role end,
          v_pay.isp_id, 'payment:initiated', 'payment', v_pay.id::text,
          jsonb_build_object('amount', v_pay.amount, 'reference', v_pay.provider_reference,
                             'provider', 'payhero'));

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_pay.id,
    'reference', v_pay.provider_reference,
    'amount', v_pay.amount,
    'currency', 'KES',
    -- Returned to the calling server only. Never to a browser.
    'payhero_channel_id', v_cfg.payhero_channel_id,
    'isp_id', v_pay.isp_id,
    'status', 'pending'
  );
end;
$$;

revoke all on function public.create_payhero_payment(uuid, uuid, uuid, text) from public;
grant execute on function public.create_payhero_payment(uuid, uuid, uuid, text) to service_role;
-- Stamps the PayHero transaction reference returned by STK initiation.
-- Still pending: a prompt sent is not a payment made.
create or replace function public.record_payhero_stk(
  p_payment_id     uuid,
  p_transaction_id text
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
begin
  if p_payment_id is null or p_transaction_id is null or p_transaction_id = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_reference');
  end if;

  update public.payments
     set provider_transaction_id = p_transaction_id
   where id = p_payment_id
     and status = 'pending';

  if not found then
    -- Either the payment does not exist or it is no longer pending. Both mean the
    -- STK response arrived too late to be recorded, and reporting which would be
    -- a needless information leak. A settled payment must never have its provider
    -- transaction id rewritten by a late STK response.
    return jsonb_build_object('ok', false, 'reason', 'payment_not_pending');
  end if;

  return jsonb_build_object('ok', true, 'provider_transaction_id', p_transaction_id);
end;
$$;

revoke all on function public.record_payhero_stk(uuid, text) from public;
grant execute on function public.record_payhero_stk(uuid, text) to service_role;

-- ── 5. Tenant-isolated channel assignment ───────────────────────────────────
--
-- Assigns a discovered PayHero channel to exactly one ISP. Service-role only:
-- an ISP admin may select a channel for THEIR OWN tenant from the browser, but
-- this function is the server-side authority that enforces the one-channel-one-ISP
-- rule, so a crafted request cannot point a tenant at another's Till.
--
-- p_isp_id is passed by the caller rather than derived from a session because this
-- runs from the platform-admin edge function, but the edge function resolves it
-- from the authenticated caller's own rows first. The unique partial index above
-- is the real guarantee: a second ISP claiming the same channel raises, rather
-- than silently sharing a Till.
create or replace function public.assign_payhero_channel(
  p_isp_id        uuid,
  p_channel_id    bigint,
  p_channel_label text default null,
  p_status        text default 'connected'
) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_claimant uuid;
begin
  if p_isp_id is null or p_channel_id is null then
    raise exception 'An ISP and a channel are both required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from public.isps where id = p_isp_id) then
    raise exception 'No such ISP'
      using errcode = 'foreign_key_violation';
  end if;

  -- Report the conflict before writing, so the caller gets a clear message
  -- instead of a raw unique-violation.
  select isp_id into v_claimant
    from public.isp_payment_configs
   where payhero_channel_id = p_channel_id
     and isp_id <> p_isp_id;

  if v_claimant is not null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'channel_already_assigned',
      'message', 'That PayHero channel is already assigned to another ISP.');
  end if;

  insert into public.isp_payment_configs as c (isp_id, payment_provider, payhero_channel_id, payhero_channel_label)
  values (p_isp_id, 'payhero', p_channel_id, coalesce(p_channel_label, ''))
  on conflict (isp_id) do update
    set payment_provider       = 'payhero',
        payhero_channel_id     = excluded.payhero_channel_id,
        payhero_channel_label  = excluded.payhero_channel_label,
        connection_status      = p_status::public.payment_channel_status,
        channel_provider_status = 'connected'::text,
        updated_at             = now()
  returning c.isp_id into v_claimant;

  return jsonb_build_object(
    'ok', true,
    'isp_id', v_claimant,
    'payhero_channel_id', p_channel_id,
    'connection_status', p_status);
end;
$$;

revoke all on function public.assign_payhero_channel(uuid, bigint, text, text) from public;
grant execute on function public.assign_payhero_channel(uuid, bigint, text, text) to service_role;

commit;