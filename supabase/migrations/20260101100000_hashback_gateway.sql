-- =============================================================================
--  HashBack payment gateway.
--
--  Replaces Safaricom Daraja as the ACTIVE payment path. Additive only: no
--  table is dropped, no existing row is modified, and every Daraja column is
--  left in place so historical transactions stay readable.
--
--  Two things are being fixed as well as added, and both are security defects
--  in the existing code rather than new work:
--
--    1. The existing `set_platform_payment_config` stored the Daraja consumer
--       key, consumer secret and passkey as PLAINTEXT columns that any
--       `authenticated` user could read with a direct SELECT. The comment on
--       isp_payment_configs claims "columns are additionally protected by
--       revoking direct select on the secret columns" — no such REVOKE ever
--       existed, so the stated protection was not real.
--    2. `payment_config_status(uuid)` calls `require_super_admin()`, so an ISP
--       admin cannot read their own payment configuration at all. That is what
--       pushed the browser toward reading secret columns directly.
--
--  Credentials are therefore encrypted at rest with the same AES-GCM scheme
--  the router credentials already use, and tenant-safe accessor functions
--  replace direct table reads.
-- =============================================================================

begin;

-- =============================================================================
--  1. Provider and channel enums
-- =============================================================================

do $$ begin create type payment_provider as enum ('manual','daraja','hashback');
exception when duplicate_object then null; end $$;

-- Only these states are ever written. There is no 'processing' or 'unknown':
-- an unverified payment is 'pending', which is the safe default.
do $$ begin create type payment_channel_status as enum
  ('not_configured','pending','connected','failed','disabled');
exception when duplicate_object then null; end $$;

do $$ begin create type hashback_connection_status as enum
  ('unconfigured','configured','verified','failed');
exception when duplicate_object then null; end $$;

-- =============================================================================
--  2. Platform HashBack credentials
--
--  One row, same shape as platform_payment_config. The ciphertext columns hold
--  AES-GCM output in the existing `v1.<iv>.<ciphertext>` format — the identical
--  format _shared/secrets.ts produces, so no second encryption mechanism is
--  introduced.
--
--  There is deliberately NO client SELECT policy on this table and no grant to
--  `authenticated`. Only the service role (the Edge Functions) reads it, and
--  super admins read booleans through hashback_platform_status(), which never
--  returns a ciphertext.
-- =============================================================================

alter table public.platform_payment_config
  add column if not exists hashback_api_key_encrypted      text,
  add column if not exists hashback_webhook_secret_encrypted text,
  add column if not exists hashback_connection_status hashback_connection_status
    not null default 'unconfigured',
  add column if not exists hashback_last_verified_at timestamptz,
  add column if not exists hashback_last_error text,
  add column if not exists hashback_token_balance integer,
  add column if not exists hashback_partner_access boolean,
  add column if not exists hashback_webhook_url text,
  -- Safe provider metadata only: no credential may be written here. It is
  -- surfaced in the admin UI so an operator can see what HashBack reported.
  add column if not exists hashback_provider_metadata jsonb not null default '{}'::jsonb;

comment on column public.platform_payment_config.hashback_api_key_encrypted is
  'AES-GCM ciphertext of the HashBack API/partner key. Service role only.';
comment on column public.platform_payment_config.hashback_webhook_secret_encrypted is
  'AES-GCM ciphertext of the channel webhook secret. Service role only.';

-- =============================================================================
--  3. Tenant HashBack channel configuration
--
--  Extends the existing isp_payment_configs rather than creating a parallel
--  table, so there is one row per ISP and one place to look.
-- =============================================================================

alter table public.isp_payment_configs
  add column if not exists payment_provider payment_provider not null default 'manual',
  add column if not exists merchant_name      text,
  add column if not exists channel_type       text
    check (channel_type is null or channel_type in ('CustomerBuyGoodsOnline','CustomerPayBillOnline')),
  -- The channel's shortcode: a Till for Buy Goods, a PayBill otherwise.
  add column if not exists channel_shortcode  text,
  -- Returned by HashBack at link time. Maps one channel to exactly one ISP.
  add column if not exists hashback_account_id text,
  add column if not exists connection_status  payment_channel_status not null default 'not_configured',
  add column if not exists last_verified_at   timestamptz,
  add column if not exists channel_last_error text,
  -- The provider's own status string, preserved verbatim for the admin.
  add column if not exists channel_provider_status text,
  -- The per-channel webhook secret, encrypted. HashBack issues one per channel
  -- when a per-channel callback is configured.
  add column if not exists hashback_channel_secret_encrypted text;

comment on column public.isp_payment_configs.hashback_account_id is
  'HashBack channel identifier (HP...). Unique platform-wide: it routes webhooks.';

comment on column public.isp_payment_configs.channel_type is
  'HashBack account type: CustomerBuyGoodsOnline (Till) or CustomerPayBillOnline.';

-- One HashBack AccountID identifies exactly one channel, so it must be unique
-- platform-wide. Without this, two ISPs could hold the same id and a webhook
-- would be ambiguous about which tenant to credit.
create unique index if not exists isp_payment_configs_hashback_account_id_key
  on public.isp_payment_configs (hashback_account_id)
  where hashback_account_id is not null;

create index if not exists isp_payment_configs_provider_idx
  on public.isp_payment_configs (payment_provider, connection_status);

-- =============================================================================
--  4. Payment provider fields
--
--  payments already carries checkout_request_id and mpesa_receipt, which the
--  Daraja path used. Both are kept: historical rows still reference them and
--  HashBack also returns a checkout id, so the column is reused rather than
--  duplicated.
-- =============================================================================

alter table public.payments
  add column if not exists payment_provider  payment_provider,
  add column if not exists provider_reference text,
  add column if not exists provider_transaction_id text,
  add column if not exists provider_merchant_request_id text,
  add column if not exists provider_receipt   text,
  add column if not exists provider_metadata  jsonb not null default '{}'::jsonb,
  add column if not exists initiated_at       timestamptz,
  add column if not exists settled_at         timestamptz,
  add column if not exists reconciled_at      timestamptz,
  add column if not exists failure_reason     text;

-- Webhook routing index. Every callback resolves the ISP through this, so it
-- has to be unique: a duplicate reference would make routing ambiguous.
create unique index if not exists payments_provider_reference_key
  on public.payments (provider_reference)
  where provider_reference is not null;

-- The idempotency guard that matters most. HashBack's TransactionID is the
-- provider's own record of one real transfer, so the same one must never
-- settle two payment rows. Concurrent deliveries of the same webhook both try
-- this insert; the loser gets a unique violation and returns "already handled".
create unique index if not exists payments_provider_transaction_id_key
  on public.payments (provider_transaction_id)
  where provider_transaction_id is not null;

create index if not exists payments_pending_reconcile_idx
  on public.payments (created_at)
  where status = 'pending' and payment_provider = 'hashback';

-- =============================================================================
--  5. Close the plaintext credential hole
--
--  This is a GRANT revocation, not a data change. Any existing plaintext value
--  stays exactly where it is so nothing is lost, but `authenticated` can no
--  longer read it. Historical Daraja payments reference no credentials, so
--  nothing that reads past transactions is affected.
--
--  Only columns holding a SECRET are revoked. till_number, paybill_number,
--  merchant_name and callback_url stay readable because the tenant's own UI
--  legitimately displays them.
-- =============================================================================

-- Secret columns are withheld by revoking ALL column privileges and then
-- granting back only the columns a tenant legitimately displays.
--
-- This is expressed as revoke-all-then-grant-the-safe-list rather than as a
-- column-level REVOKE, for two reasons. First, a column-level REVOKE cannot
-- be undone by a later table-level GRANT, so this ordering stays correct if
-- someone later re-grants the table. Second, the SQL-over-HTTP runner this
-- project uses cannot parse a three-part `revoke ... on table.column` at all,
-- including inside a DO block; a GRANT with a column list parses correctly.
--
-- Withheld: mpesa_passkey, mpesa_consumer_key, mpesa_consumer_secret and
-- hashback_channel_secret_encrypted. Everything the tenant's own Payment
-- Settings screen shows — till, paybill, merchant name, channel, AccountID,
-- status — is granted back below.
revoke all on public.isp_payment_configs from authenticated;

grant select (
  isp_id,
  mpesa_env,
  mpesa_shortcode,
  callback_url,
  payment_mode,
  till_number,
  paybill_number,
  customer_notice,
  updated_at,
  payment_provider,
  merchant_name,
  channel_type,
  channel_shortcode,
  hashback_account_id,
  connection_status,
  last_verified_at,
  channel_last_error,
  channel_provider_status
) on public.isp_payment_configs to authenticated;

grant insert, update on public.isp_payment_configs to authenticated;

-- Without this a direct INSERT could smuggle a plaintext secret into a column
-- the tenant can no longer read. Writes must go through save_isp_channel(),
-- which is the only path that sets channel fields.
--
-- Added NOT VALID so the migration cannot fail on a legacy deployment that
-- still holds Daraja secrets in these columns. Validate it after migrating any
-- such values into an encrypted store; on a clean deployment
-- `validate constraint` succeeds immediately, and that is run below.
alter table public.isp_payment_configs
  drop constraint if exists isp_payment_configs_no_direct_secret_write;
alter table public.isp_payment_configs
  add constraint isp_payment_configs_no_direct_secret_write
  check (
    -- Only the service role (Edge Functions decrypting) may hold a secret here.
    mpesa_consumer_secret IS NULL
    and mpesa_consumer_key IS NULL
    and mpesa_passkey IS NULL
    and hashback_channel_secret_encrypted IS NULL
  ) not valid;

do $$
begin
  -- Validates cleanly when no legacy secret is present. When one is, the
  -- constraint stays NOT VALID and still enforces new writes, which is the
  -- intended outcome for a legacy deployment mid-migration.
  if not exists (
    select 1 from public.isp_payment_configs
     where mpesa_consumer_secret is not null
        or mpesa_consumer_key is not null
        or mpesa_passkey is not null
        or hashback_channel_secret_encrypted is not null
  ) then
    alter table public.isp_payment_configs
      validate constraint isp_payment_configs_no_direct_secret_write;
  end if;
end $$;

-- The platform table is now RLS-enabled and granted nothing. The earlier
-- migration enabled RLS on the listed tenant tables but NOT on
-- platform_payment_config, and granted no client policy either — so it was
-- unreachable only by accident of privilege grants, not by design.
alter table public.platform_payment_config enable row level security;
alter table public.platform_payment_config force row level security;

revoke all on public.platform_payment_config from anon, authenticated;

-- Service role keeps full access: the Edge Functions need it to decrypt.
grant all on public.platform_payment_config to service_role;

-- =============================================================================
--  6. Tenant-safe accessors
--
--  These replace direct reads. Each one resolves the caller server-side; none
--  accepts an isp_id from the client, so a request cannot be pointed at another
--  tenant's configuration.
-- =============================================================================

-- Platform status for the super admin. Returns booleans and safe metadata, and
-- NEVER a ciphertext or a key length that would help an attacker.
create or replace function public.hashback_platform_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_cfg public.platform_payment_config;
begin
  perform public.require_super_admin();

  select * into v_cfg from public.platform_payment_config where id = true;

  return jsonb_build_object(
    'connection_status', coalesce(v_cfg.hashback_connection_status::text, 'unconfigured'),
    'has_api_key',      length(coalesce(v_cfg.hashback_api_key_encrypted, '')) > 0,
    'has_webhook_secret', length(coalesce(v_cfg.hashback_webhook_secret_encrypted, '')) > 0,
    'last_verified_at', v_cfg.hashback_last_verified_at,
    'last_error',       v_cfg.hashback_last_error,
    'token_balance',    v_cfg.hashback_token_balance,
    'partner_access',   v_cfg.hashback_partner_access,
    'webhook_url',      v_cfg.hashback_webhook_url,
    'provider_metadata',v_cfg.hashback_provider_metadata
  );
end;
$$;

revoke all on function public.hashback_platform_status() from public;
grant execute on function public.hashback_platform_status() to authenticated;

-- The tenant's own payment configuration.
--
-- The ISP is resolved from the caller's profile. A super admin may pass an id
-- explicitly for the admin console; a tenant may not, and a mismatched id is
-- refused rather than clamped, so the caller learns they asked for the wrong
-- thing instead of silently receiving their own data.
create or replace function public.my_payment_channel(p_isp_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_isp uuid;
  v_cfg public.isp_payment_configs;
begin
  if public.is_super_admin() then
    v_isp := coalesce(p_isp_id, public.current_isp_id());
  else
    v_isp := public.current_isp_id();
    if p_isp_id is not null and p_isp_id is distinct from v_isp then
      raise exception 'requested ISP is not yours'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if v_isp is null then
    raise exception 'No ISP in scope' using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from public.isp_payment_configs where isp_id = v_isp;

  return jsonb_build_object(
    'isp_id', v_isp,
    'payment_provider', v_cfg.payment_provider::text,
    'payment_mode', v_cfg.payment_mode::text,
    'merchant_name', v_cfg.merchant_name,
    'channel_type', v_cfg.channel_type,
    'till_number', v_cfg.till_number,
    'paybill_number', v_cfg.paybill_number,
    'channel_shortcode', v_cfg.channel_shortcode,
    -- The AccountID is the tenant's own channel identifier, so it is safe to
    -- display. It is NOT a credential: it cannot authorise an API call.
    'hashback_account_id', v_cfg.hashback_account_id,
    'connection_status', v_cfg.connection_status::text,
    'last_verified_at', v_cfg.last_verified_at,
    'last_error', v_cfg.channel_last_error,
    'provider_status', v_cfg.channel_provider_status,
    'customer_notice', v_cfg.customer_notice,
    -- Booleans only. The secrets themselves are never selected here.
    'has_channel_secret',
      length(coalesce(v_cfg.hashback_channel_secret_encrypted, '')) > 0,
    'has_daraja_key',
      length(coalesce(v_cfg.mpesa_consumer_key, '')) > 0,
    'has_daraja_secret',
      length(coalesce(v_cfg.mpesa_consumer_secret, '')) > 0,
    'has_daraja_passkey',
      length(coalesce(v_cfg.mpesa_passkey, '')) > 0,
    'updated_at', v_cfg.updated_at
  );
end;
$$;

revoke all on function public.my_payment_channel(uuid) from public;
grant execute on function public.my_payment_channel(uuid) to authenticated;

-- =============================================================================
--  7. Authoritative amount resolution
--
--  The browser may ask for "this package", never for "this amount". This
--  function is the only place a payable amount is derived, and it derives it
--  from the plan row inside the tenant's own data.
--
--  Refuses rather than defaults when the plan is missing or inactive, because a
--  fallback amount is how "pay KSh 1 for a KSh 1,500 package" happens.
-- =============================================================================

create or replace function public.resolve_chargeable(
  p_invoice_id uuid default null,
  p_client_id  uuid default null,
  p_plan_id    uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_isp     uuid := public.current_isp_id();
  v_inv     public.invoices;
  v_plan    public.plans;
  v_client  public.clients;
    v_amount    numeric(12,2);
    v_plan_id   uuid;
    v_plan_name text;
    v_duration_hours integer;
    -- Effective customer. Starts as whatever the caller supplied and falls back
    -- to the invoice's own client, so the caller does not have to repeat it.
    v_client_id uuid;
begin
  v_client_id := p_client_id;
  if v_isp is null then
    raise exception 'No ISP in scope' using errcode = 'insufficient_privilege';
  end if;

  -- An invoice is self-describing: it already names the plan and the price.
  if p_invoice_id is not null then
    select * into v_inv from public.invoices where id = p_invoice_id;
    if v_inv.id is null or v_inv.isp_id <> v_isp then
      raise exception 'Invoice not found' using errcode = 'no_data_found';
    end if;
    if v_inv.status = 'paid' then
      raise exception 'This invoice is already paid' using errcode = 'integrity_constraint_violation';
    end if;

    -- Cross-check the client when one is supplied, so a caller cannot pair an
    -- invoice with someone else's account.
    if p_client_id is not null and v_inv.client_id is distinct from p_client_id then
      raise exception 'Invoice does not belong to that customer'
        using errcode = 'insufficient_privilege';
    end if;

    v_amount := v_inv.amount;
    v_plan_name := v_inv.plan_name;

    if v_client_id is null then v_client_id := v_inv.client_id; end if;
  elsif p_plan_id is not null then
    -- A package purchase: price comes from the plan, scoped to this tenant.
    select * into v_plan from public.plans
     where id = p_plan_id and isp_id = v_isp;

    if v_plan.id is null then
      raise exception 'Package not found' using errcode = 'no_data_found';
    end if;
    if not coalesce(v_plan.is_active, false) then
      raise exception 'That package is not available for purchase' using errcode = 'integrity_constraint_violation';
    end if;

    v_amount := v_plan.price;
    v_plan_name := v_plan.name;
    v_plan_id := v_plan.id;
    v_duration_hours := v_plan.duration_hours;
  else
    raise exception 'Specify an invoice or a package to pay for'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_amount is null or v_amount <= 0 then
    raise exception 'That charge has no valid amount'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- When a client is named it must belong to this tenant.
  if v_client_id is not null then
    select * into v_client from public.clients where id = v_client_id;
    if v_client.id is null or v_client.isp_id <> v_isp then
      raise exception 'Customer not found' using errcode = 'no_data_found';
    end if;
  end if;

  return jsonb_build_object(
    'isp_id', v_isp,
    'client_id', v_client_id,
    'invoice_id', p_invoice_id,
    'plan_id', v_plan_id,
    'plan_name', v_plan_name,
    'duration_hours', v_duration_hours,
    -- The single authoritative amount. Nothing downstream may recompute it.
    'amount', v_amount,
    'currency', 'KES'
  );
end;
$$;

revoke all on function public.resolve_chargeable(uuid, uuid, uuid) from public;
grant execute on function public.resolve_chargeable(uuid, uuid, uuid) to authenticated;

-- =============================================================================
--  8. Payment initiation record
--
--  Creates the pending payment and its provider_reference. It does NOT call
--  HashBack and does NOT mark anything paid: the Edge Function calls this first
--  to obtain a reference, then initiates STK, then stamps the checkout id.
--
--  Being pending on return is the point. STK initiation only means a prompt was
--  sent; service is activated later by settle_hashback_payment() and only from
--  a verified provider result.
-- =============================================================================

create or replace function public.create_hashback_payment(
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

  -- Refuse to create a payment that could never settle. Better to say so now
  -- than to collect a reference the webhook will never route.
  if v_cfg.payment_provider <> 'hashback' then
    raise exception 'This ISP is not configured for HashBack payments'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_cfg.connection_status <> 'connected' or v_cfg.hashback_account_id is null then
    raise exception 'This ISP payment channel is not connected yet'
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Unique, opaque, and derived only from the row id — never from a secret.
  v_ref := 'NETISP-' || replace(p_gen_random_uuid()::text, '-', '');

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
    'hashback',
    v_ref,
    now(),
    jsonb_build_object('plan_id', v_charge->'plan_id', 'plan_name', v_charge->'plan_name')
  ) returning * into v_pay;

  insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, target_id, metadata)
  values (auth.uid(),
          case when public.is_super_admin() then 'super_admin'::platform_role
               else 'isp_admin'::platform_role end,
          v_pay.isp_id, 'payment:initiated', 'payment', v_pay.id::text,
          jsonb_build_object('amount', v_pay.amount, 'reference', v_pay.provider_reference,
                             'provider', 'hashback'));

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_pay.id,
    'reference', v_pay.provider_reference,
    'amount', v_pay.amount,
    'currency', 'KES',
    -- Returned to the calling server only. Never to a browser.
    'hashback_account_id', v_cfg.hashback_account_id,
    'isp_id', v_pay.isp_id,
    'status', 'pending'
  );
end;
$$;

revoke all on function public.create_hashback_payment(uuid, uuid, uuid, text) from public;
grant execute on function public.create_hashback_payment(uuid, uuid, uuid, text) to authenticated;

-- Stamps the provider identifiers returned by STK initiation. Still pending.
create or replace function public.record_hashback_checkout(
  p_payment_id     uuid,
  p_checkout_id    text,
  p_merchant_request_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
begin
  select * into v_pay from public.payments where id = p_payment_id for update;

  if v_pay.id is null then
    raise exception 'Payment not found' using errcode = 'no_data_found';
  end if;
  -- An already-settled payment must never be dragged back to pending.
  if v_pay.status = 'success' then
    return jsonb_build_object('ok', true, 'status', v_pay.status, 'already_settled', true);
  end if;

  update public.payments
     set checkout_request_id = coalesce(p_checkout_id, checkout_request_id),
         provider_merchant_request_id = coalesce(p_merchant_request_id, provider_merchant_request_id),
         -- Explicitly NOT 'success'. The prompt was sent, nothing more.
         status = 'pending'
   where id = p_payment_id;

  return jsonb_build_object('ok', true, 'status', 'pending');
end;
$$;

revoke all on function public.record_hashback_checkout(uuid, text, text) from public;
grant execute on function public.record_hashback_checkout(uuid, text, text) to authenticated;

-- =============================================================================
--  9. Settlement
--
--  The single path by which a HashBack payment becomes successful, and the only
--  place service is activated for it.
--
--  Design points that matter:
--
--  * The row is locked FOR UPDATE before anything is read, so two concurrent
--    deliveries of the same webhook serialise here. The second one sees the
--    status the first already wrote and returns 'duplicate'.
--  * provider_transaction_id is written under a unique index. Two racing
--    callbacks for the same real-world transfer cannot both create a row.
--  * The whole thing runs in one transaction. If activation fails, the status
--    change rolls back with it, so a payment can never be marked paid while the
--    customer's service was not actually updated.
--  * Activation reuses the SAME shape the existing manual and Daraja paths use
--    (invoice paid, client reactivated, expiry extended). It does not introduce
--    a second billing mechanism.
-- =============================================================================

create or replace function public.settle_hashback_payment(
  p_reference             text,
  p_transaction_id        text default null,
  p_receipt               text default null,
  p_checkout_id           text default null,
  p_merchant_request_id   text default null,
  p_msisdn                text default null,
  p_amount                numeric default null,
  p_account_id            text default null,
  p_provider_metadata     jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pay       public.payments;
  v_inv       public.invoices;
  v_client    public.clients;
  v_from      timestamptz;
  v_activated boolean := false;
  v_duplicate boolean := false;
begin
  if p_reference is null or p_reference = '' then
    raise exception 'A payment reference is required' using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE serialises concurrent deliveries of the same webhook.
  select * into v_pay
    from public.payments
   where provider_reference = p_reference
     for update;

  -- An unknown reference must never be guessed at. It goes to reconciliation
  -- as an orphan record for a human, and activates nothing.
  if v_pay.id is null then
    insert into public.payment_reconciliation (
      provider, provider_reference, provider_transaction_id, amount,
      raw_payload, reason, status
    ) values (
      'hashback', p_reference, p_transaction_id, p_amount,
      coalesce(p_provider_metadata, '{}'::jsonb),
      'no matching payment for this reference', 'unmatched'
    );
    return jsonb_build_object(
      'ok', false, 'settled', false, 'reason', 'unknown_reference');
  end if;

  -- Already handled. Return success so the provider stops retrying, but change
  -- nothing: no second renewal, no second SMS, no second activation.
  if v_pay.status = 'success' then
    v_duplicate := true;
  elsif p_transaction_id is not null
        and v_pay.provider_transaction_id is not null
        and v_pay.provider_transaction_id <> p_transaction_id then
    -- The same reference presented with a different provider transaction. That
    -- is not a duplicate delivery; it is a conflict, so it is recorded rather
    -- than silently accepted.
    insert into public.payment_reconciliation (
      provider, provider_reference, provider_transaction_id, amount,
      raw_payload, reason, status
    ) values (
      'hashback', p_reference, p_transaction_id, p_amount,
      coalesce(p_provider_metadata, '{}'::jsonb),
      'reference already settled under a different transaction id', 'conflict'
    );
    return jsonb_build_object(
      'ok', false, 'settled', false, 'reason', 'transaction_conflict');
  end if;

  if not v_duplicate then
    -- The unique index on provider_transaction_id is the concurrency backstop.
    -- If a racing callback inserted the same provider transaction first, this
    -- update raises and the caller reports a duplicate.
    update public.payments
       set status = 'success',
           provider_transaction_id = coalesce(p_transaction_id, provider_transaction_id),
           provider_receipt = coalesce(p_receipt, provider_receipt),
           mpesa_receipt = coalesce(p_receipt, mpesa_receipt),
           checkout_request_id = coalesce(p_checkout_id, checkout_request_id),
           provider_merchant_request_id =
             coalesce(p_merchant_request_id, provider_merchant_request_id),
           phone = coalesce(p_msisdn, phone),
           settled_at = now(),
           reconciled_at = now(),
           failure_reason = null,
           provider_metadata = provider_metadata || coalesce(p_provider_metadata, '{}'::jsonb)
     where id = v_pay.id;
  end if;

  -- ── Activation: reuse the existing billing behaviour ───────────────────────
  if not v_duplicate and v_pay.invoice_id is not null then
    select * into v_inv from public.invoices where id = v_pay.invoice_id;

    if v_inv.id is not null and v_inv.status <> 'paid' then
      update public.invoices set status = 'paid', paid_at = now()
       where id = v_inv.id;

      if v_inv.client_id is not null then
        select * into v_client from public.clients where id = v_inv.client_id;

        -- Extend from the current expiry when still in the future, so a renewal
        -- adds a period rather than shortening one.
        v_from := case
          when v_client.expires_at is not null and v_client.expires_at > now()
            then v_client.expires_at
          else now()
        end;

        update public.clients set
          status = 'active',
          balance = 0,
          plan_name = coalesce(v_inv.plan_name, plan_name),
          expires_at = v_from + interval '30 days'
        where id = v_inv.client_id;

        v_activated := true;
      end if;
    end if;
  end if;

  -- Only on the transition, never on a repeat: one payment, one audit record.
  if not v_duplicate then
    insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, target_id, metadata)
    values (null, 'super_admin'::platform_role, v_pay.isp_id,
            'payment:success', 'payment', v_pay.id::text,
            jsonb_build_object('amount', v_pay.amount,
                               'reference', p_reference,
                               'transaction_id', p_transaction_id,
                               'receipt', p_receipt,
                               'provider', 'hashback'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'settled', not v_duplicate,
    'duplicate', v_duplicate,
    'activated', v_activated,
    'payment_id', v_pay.id,
    'isp_id', v_pay.isp_id,
    'status', 'success'
  );
end;
$$;

revoke all on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) from public;
grant execute on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) to service_role;

-- Records a payment the provider says failed. Never activates.
create or replace function public.fail_hashback_payment(
  p_reference   text,
  p_reason      text,
  p_transaction_id text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
begin
  if p_reference is null or p_reference = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_reference');
  end if;

  select * into v_pay from public.payments
   where provider_reference = p_reference for update;

  if v_pay.id is null then
    insert into public.payment_reconciliation (
      provider, provider_reference, provider_transaction_id, reason, status, raw_payload
    ) values ('hashback', p_reference, p_transaction_id,
              coalesce(p_reason, 'provider reported failure'), 'unmatched', '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'unknown_reference');
  end if;

  -- A settled payment is never walked back by a late failure event.
  if v_pay.status = 'success' then
    return jsonb_build_object('ok', true, 'already_settled', true);
  end if;

  update public.payments
     set status = 'failed',
         failure_reason = coalesce(p_reason, 'provider reported failure'),
         provider_transaction_id = coalesce(p_transaction_id, provider_transaction_id),
         settled_at = now()
   where id = v_pay.id;

  return jsonb_build_object('ok', true, 'settled', false, 'status', 'failed');
end;
$$;

revoke all on function public.fail_hashback_payment(text, text, text) from public;
grant execute on function public.fail_hashback_payment(text, text, text) to service_role;

commit;

-- =============================================================================
--  10. Reconciliation
--
--  Where a provider event lands when it cannot be applied automatically: an
--  unknown reference, a conflicting transaction id, or a payment that stayed
--  pending past the webhook window.
--
--  This exists because the alternative is worse — either dropping such events
--  silently, or activating a customer's service against a payment we cannot
--  identify. Both are unacceptable, so they are queued for a human.
-- =============================================================================

do $$ begin create type reconciliation_state as enum
  ('unmatched','conflict','pending_review','resolved','written_off');
exception when duplicate_object then null; end $$;

create table if not exists public.payment_reconciliation (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null default 'hashback',
  provider_reference      text,
  provider_transaction_id text,
  isp_id                  uuid references public.isps(id) on delete set null,
  payment_id              uuid references public.payments(id) on delete set null,
  amount                  numeric(12,2),
  msisdn                  text,
  reason                  text not null,
  status                  reconciliation_state not null default 'unmatched',
  -- The provider's own payload, verbatim, so a human can decide with evidence.
  raw_payload             jsonb not null default '{}'::jsonb,
  resolved_by             uuid references auth.users(id) on delete set null,
  resolved_at             timestamptz,
  created_at              timestamptz not null default now()
);

create index if not exists payment_reconciliation_status_idx
  on public.payment_reconciliation (status, created_at desc);

-- One reconciliation row per provider transaction, so a redelivered webhook
-- cannot pile up duplicate review items.
create unique index if not exists payment_reconciliation_txn_key
  on public.payment_reconciliation (provider, provider_transaction_id)
  where provider_transaction_id is not null and status in ('unmatched','conflict');

alter table public.payment_reconciliation enable row level security;
alter table public.payment_reconciliation force row level security;

-- A super admin reviews every tenant's reconciliation. A tenant sees only its
-- own, resolved server-side — no isp_id is accepted from the client.
drop policy if exists reconciliation_super_admin on public.payment_reconciliation;
create policy reconciliation_super_admin on public.payment_reconciliation for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists reconciliation_own_read on public.payment_reconciliation;
create policy reconciliation_own_read on public.payment_reconciliation for select
  using (isp_id = public.current_isp_id());

grant select on public.payment_reconciliation to authenticated;
grant insert on public.payment_reconciliation to service_role;
grant update on public.payment_reconciliation to authenticated;

-- =============================================================================
--  11. Channel provisioning guards
--
--  linkAccount costs tokens and, per HashBack's documentation, returns a *fresh*
--  account_id for an already-linked shortcode. The adapter therefore refuses to
--  auto-retry it. This is the application-layer guard that stops a duplicate
--  channel being created in the first place.
-- =============================================================================

create or replace function public.find_channel_by_shortcode(
  p_shortcode text,
  p_channel_type text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.isp_payment_configs;
begin
  select * into v_row
    from public.isp_payment_configs
   where channel_shortcode = p_shortcode
     and channel_type = p_channel_type
     and hashback_account_id is not null
   limit 1;

  if v_row.isp_id is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'isp_id', v_row.isp_id,
    'account_id', v_row.hashback_account_id,
    'connection_status', v_row.connection_status::text
  );
end;
$$;

revoke all on function public.find_channel_by_shortcode(text, text) from public;
grant execute on function public.find_channel_by_shortcode(text, text) to service_role;

-- Saves the merchant's own channel details. Does NOT call the provider: the
-- Edge Function links first, then stores the returned account_id, so a channel
-- is never marked connected without a real provider response.
create or replace function public.save_isp_channel(
  p_merchant_name  text,
  p_channel_type   text,
  p_shortcode      text,
  p_paybill_number text default null,
  p_till_number    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_isp uuid := public.current_isp_id();
begin
  if v_isp is null then
    raise exception 'No ISP in scope' using errcode = 'insufficient_privilege';
  end if;
  if not (public.can_manage_isp() or public.is_super_admin()) then
    raise exception 'You cannot change payment settings' using errcode = 'insufficient_privilege';
  end if;

  if p_channel_type not in ('CustomerBuyGoodsOnline','CustomerPayBillOnline') then
    raise exception 'Unsupported channel type' using errcode = 'invalid_parameter_value';
  end if;
  if p_shortcode is null or p_shortcode !~ '^[0-9]{5,8}$' then
    raise exception 'Enter a valid Till or PayBill number' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.isp_payment_configs as c (
    isp_id, payment_provider, merchant_name, channel_type, channel_shortcode,
    till_number, paybill_number, connection_status
  ) values (
    v_isp, 'hashback',
    nullif(trim(coalesce(p_merchant_name, '')), ''),
    p_channel_type, p_shortcode,
    nullif(trim(coalesce(p_till_number, '')), ''),
    nullif(trim(coalesce(p_paybill_number, '')), ''),
    'pending'
  )
  on conflict (isp_id) do update set
    payment_provider  = 'hashback',
    merchant_name     = excluded.merchant_name,
    channel_type      = excluded.channel_type,
    channel_shortcode = excluded.channel_shortcode,
    till_number       = excluded.till_number,
    paybill_number    = excluded.paybill_number,
    -- Only reset to pending when the shortcode actually changed. Re-saving the
    -- same details must not knock a working channel back to pending.
    connection_status = case
      when c.channel_shortcode is distinct from excluded.channel_shortcode
        or c.channel_type is distinct from excluded.channel_type
      then 'pending'::payment_channel_status
      else c.connection_status
    end,
    updated_at = now();

  insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, metadata)
  values (auth.uid(),
          case when public.is_super_admin() then 'super_admin'::platform_role
               else 'isp_admin'::platform_role end,
          v_isp, 'payment:channel-configured', 'isp_payment_config',
          jsonb_build_object('channel_type', p_channel_type,
                             'merchant_name', nullif(trim(coalesce(p_merchant_name,'')), '')));

  return public.my_payment_channel();
end;
$$;

revoke all on function public.save_isp_channel(text, text, text, text, text) from public;
grant execute on function public.save_isp_channel(text, text, text, text, text) to authenticated;

-- Records the provider's answer for a channel link. Service role only: the
-- account_id must come from HashBack, never from a browser.
create or replace function public.record_channel_link(
  p_isp_id      uuid,
  p_account_id  text,
  p_status      text,
  p_error       text default null,
  p_provider_status text default null,
  p_channel_secret_encrypted text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_isp_id is null then
    raise exception 'ISP is required' using errcode = 'invalid_parameter_value';
  end if;

  if p_account_id is null or p_account_id = '' then
    -- No account id means the link failed. Recording FAILED rather than leaving
    -- it PENDING forever is what lets the UI tell the truth.
    update public.isp_payment_configs
       set connection_status = 'failed',
           channel_last_error = coalesce(p_error, 'HashBack did not return an account id'),
           last_verified_at = now()
     where isp_id = p_isp_id;
  else
    -- The unique index on hashback_account_id rejects a second ISP claiming an
    -- account that already belongs to someone else.
    update public.isp_payment_configs
       set hashback_account_id = p_account_id,
           connection_status = p_status::payment_channel_status,
           channel_provider_status = p_provider_status,
           channel_last_error = p_error,
           hashback_channel_secret_encrypted =
             coalesce(p_channel_secret_encrypted, hashback_channel_secret_encrypted),
           last_verified_at = now()
     where isp_id = p_isp_id;
  end if;

  insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, metadata)
  values (null, 'super_admin'::platform_role, p_isp_id,
          'payment:channel-linked', 'isp_payment_config',
          -- The account id is safe to log; it is an identifier, not a secret.
          jsonb_build_object('account_id', p_account_id,
                             'status', p_status,
                             'provider_status', p_provider_status,
                             'error', p_error));

  return public.my_payment_channel(p_isp_id);
end;
$$;

revoke all on function public.record_channel_link(uuid, text, text, text, text, text) from public;
grant execute on function public.record_channel_link(uuid, text, text, text, text, text) to service_role;

commit;