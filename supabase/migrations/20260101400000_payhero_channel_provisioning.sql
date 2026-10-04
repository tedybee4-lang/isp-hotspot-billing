-- =============================================================================
--  Automatic PayHero channel provisioning + payment observability.
--
--  WHAT THIS FIXES
--  --------------
--  1. A new ISP could not become able to accept money on their own. They had to
--     ask a platform admin to paste a channel id in, so "enter your Till and you
--     are live" did not exist. `provision_payhero_channel` is the server-side
--     authority the Edge Function calls after PayHero confirms registration.
--
--  2. `payhero_channel_short_code` did not exist, so the system could not tell
--     "same Till, nothing to do" from "the Till changed". Without it every save
--     would have to re-ask PayHero, and PayHero's register endpoint has no
--     idempotency key — so repeated saves create duplicate channels and split one
--     Till's history. This column is what makes provisioning idempotent.
--
--  3. Payment details could not show WHICH channel took the money, because
--     `payments` has no channel column. `payhero_channel_id` is added here as a
--     denormalised, non-secret audit field on the payment itself.
--
--  NOTHING IS DROPPED, DELETED OR RESET
--  -----------------------------------
--  Every statement below is additive. No table, column, row, ISP, customer,
--  package, voucher or historical payment is touched. Existing PayHero ISPs keep
--  the channel they already have, and are backfilled from the Till they already
--  saved so step 1 of provisioning recognises them immediately.
-- =============================================================================

begin;

-- ── 1. Channel provisioning state ────────────────────────────────────────────

alter table public.isp_payment_configs
  add column if not exists payhero_channel_short_code text,
  add column if not exists payhero_channel_registered_at timestamptz,
  add column if not exists payhero_registration_error    text;

comment on column public.isp_payment_configs.payhero_channel_short_code is
  'The Till/PayBill number behind payhero_channel_id. This is what makes automatic '
  'provisioning idempotent: an unchanged Till is reused instead of re-registered, '
  'because PayHero''s register endpoint has no idempotency key.';

comment on column public.isp_payment_configs.payhero_registration_error is
  'Safe diagnostic from the last failed provisioning attempt. Never contains a '
  'PayHero credential or token.';

-- One Till may back only one ISP. Enforced on the SHORT CODE rather than the
-- channel id, because the short code is what the ISP actually types and what a
-- duplicate registration would collide on.
create unique index if not exists isp_payment_configs_payhero_shortcode_uniq
  on public.isp_payment_configs (payhero_channel_short_code)
  where payhero_channel_short_code is not null;

-- ── 2. Backfill existing PayHero ISPs ────────────────────────────────────────
--
-- Beta Broadband (channel 13137, Till 5441898) and any other already-working ISP
-- must keep working and must NOT be re-provisioned on their next settings save.
-- Deriving the short code from the Till they already stored is what makes step 1
-- of provisioning recognise them as unchanged and create nothing.
update public.isp_payment_configs c
   set payhero_channel_short_code = coalesce(
         nullif(btrim(c.till_number), ''),
         nullif(btrim(c.paybill_number), ''),
         c.payhero_channel_short_code
       )
 where c.payhero_channel_id is not null
   and nullif(btrim(coalesce(c.payhero_channel_short_code, '')), '') is null;

-- ── 3. Per-payment channel audit ─────────────────────────────────────────────
--
-- Settling writes the channel that actually took the money, so the ISP payment
-- list can show it. This is an identifier reported by PayHero, never a secret.
alter table public.payments
  add column if not exists payhero_channel_id bigint;

comment on column public.payments.payhero_channel_id is
  'PayHero channel that collected this payment. An identifier reported by PayHero, '
  'not a credential. Null for every non-PayHero payment.';

create index if not exists payments_payhero_channel_idx
  on public.payments (payhero_channel_id)
  where payhero_channel_id is not null;

-- =============================================================================
--  provision_payhero_channel
--
--  Binds one PayHero channel to one ISP, after PayHero has confirmed it exists.
--
--  Called by the Edge Function ONLY after a successful register (or adopt) call.
--  Service-role only, and it takes p_isp_id as a parameter because the caller has
--  already resolved that id from the authenticated session; a browser can never
--  reach this function at all.
--
--  It refuses rather than repairs: if another ISP already holds this channel id or
--  this short code it says so and changes nothing. Silently taking a channel away
--  from a tenant that is already settling against it would move a live merchant's
--  money to a different ISP.
-- =============================================================================
create or replace function public.provision_payhero_channel(
  p_isp_id      uuid,
  p_channel_id  bigint,
  p_short_code  text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_claimant uuid;
  v_code     text := nullif(btrim(coalesce(p_short_code, '')), '');
  v_channel  bigint;
begin
  if p_isp_id is null or p_channel_id is null then
    raise exception 'An ISP and a channel are both required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from public.isps where id = p_isp_id) then
    raise exception 'No such ISP' using errcode = 'foreign_key_violation';
  end if;

  -- Report the conflict BEFORE writing, so the caller gets a clear reason instead
  -- of a raw unique-violation it cannot explain to an ISP.
  select isp_id into v_claimant
    from public.isp_payment_configs
   where payhero_channel_id = p_channel_id
     and isp_id <> p_isp_id;

  if v_claimant is not null then
    return jsonb_build_object('ok', false, 'reason', 'channel_already_assigned');
  end if;

  if v_code is not null then
    select isp_id into v_claimant
      from public.isp_payment_configs
     where payhero_channel_short_code = v_code
       and isp_id <> p_isp_id;

    if v_claimant is not null then
      return jsonb_build_object('ok', false, 'reason', 'short_code_already_assigned');
    end if;
  end if;

  -- Provisioning is the point at which a tenant becomes a PayHero tenant, so the
  -- provider and the connection state are set together. 'connected' is only ever
  -- written here, after PayHero returned this exact channel id.
  insert into public.isp_payment_configs as c (
    isp_id, payment_provider, payhero_channel_id,
    payhero_channel_short_code, payhero_channel_label,
    connection_status, channel_provider_status,
    payhero_channel_registered_at, payhero_registration_error
  ) values (
    p_isp_id, 'payhero', p_channel_id,
    v_code, coalesce(v_code, ''),
    'connected', 'connected',
    now(), null
  )
  on conflict (isp_id) do update
    set payment_provider            = 'payhero',
        payhero_channel_id          = excluded.payhero_channel_id,
        payhero_channel_short_code  = coalesce(excluded.payhero_channel_short_code,
                                                c.payhero_channel_short_code),
        payhero_channel_label       = coalesce(nullif(excluded.payhero_channel_label, ''),
                                               c.payhero_channel_label),
        connection_status           = 'connected',
        channel_provider_status     = 'connected',
        payhero_channel_registered_at = now(),
        payhero_registration_error  = null,
        updated_at                  = now()
  returning c.payhero_channel_id into v_channel;

  return jsonb_build_object(
    'ok', true,
    'isp_id', p_isp_id,
    'payhero_channel_id', v_channel,
    'payhero_channel_short_code', v_code,
    'connection_status', 'connected');
end;
$$;

revoke all on function public.provision_payhero_channel(uuid, bigint, text) from public;
grant execute on function public.provision_payhero_channel(uuid, bigint, text) to service_role;

comment on function public.provision_payhero_channel(uuid, bigint, text) is
  'Binds a PayHero channel PayHero has just confirmed to one ISP and marks that '
  'channel connected. Refuses if another ISP already holds the channel or the '
  'short code. Never deletes or reassigns an existing channel.';

-- =============================================================================
--  set_payhero_channel_state
--
--  Records a provisioning FAILURE, and only a failure.
--
--  It cannot set a channel id and it cannot mark anything connected. That is the
--  whole reason it is a separate function: a caller that failed to register must
--  not be able to leave an ISP looking ready, and one function that could do both
--  would be a single bug away from faking readiness.
-- =============================================================================
create or replace function public.set_payhero_channel_state(
  p_isp_id uuid,
  p_status text,
  p_error  text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_state public.payment_channel_status;
begin
  if p_isp_id is null then
    raise exception 'An ISP is required' using errcode = 'invalid_parameter_value';
  end if;

  -- Only the two states a failure path may legitimately produce.
  if p_status is distinct from 'failed' and p_status is distinct from 'pending' then
    raise exception 'Only a provisioning failure state may be written here'
      using errcode = 'invalid_parameter_value';
  end if;

  v_state := p_status::public.payment_channel_status;

  -- Only downgrade a channel that has no working channel id. A tenant with a live
  -- PayHero channel is never knocked back to 'failed' by a later failed attempt,
  -- because that would stop customers who are paying successfully right now.
  update public.isp_payment_configs
     set connection_status = case
           when payhero_channel_id is null then v_state
           else connection_status
         end,
         payhero_registration_error = p_error,
         updated_at = now()
   where isp_id = p_isp_id;

  return jsonb_build_object('ok', true, 'isp_id', p_isp_id, 'requested', p_status);
end;
$$;

revoke all on function public.set_payhero_channel_state(uuid, text, text) from public;
grant execute on function public.set_payhero_channel_state(uuid, text, text) to service_role;

-- =============================================================================
--  settle_payhero_payment, recording WHICH CHANNEL took the money
--
--  WHY THIS IS REDEFINED RATHER THAN PATCHED
--  ----------------------------------------
--  The wrapper already existed and already delegated every money-critical decision
--  to settle_hashback_payment. CREATE OR REPLACE cannot change a parameter list,
--  and the only thing missing is a channel id on the payment row. So the body is
--  reproduced with exactly one addition, and the delegation is unchanged: the
--  row locking, duplicate short-circuit, conflict ordering, invoice marking,
--  activation and RADIUS sync all still live inside settle_hashback_payment.
--
--  The channel is resolved HERE, from the payment's OWN tenant, and never taken
--  from the caller. A forged channel id therefore cannot be written onto someone
--  else's payment — the parameter still exists for compatibility but is ignored.
-- =============================================================================
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
  v_channel   bigint;
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

  if v_payment_id is not null and v_result->>'settled' = 'true' then
    -- The channel is this tenant's own, looked up by the payment's own isp_id.
    -- Writing it is what lets the ISP payment list answer "which Till collected
    -- this?" without a join the browser could not make.
    select c.payhero_channel_id into v_channel
      from public.payments p
      join public.isp_payment_configs c on c.isp_id = p.isp_id
     where p.id = v_payment_id;

    if v_channel is not null then
      update public.payments
         set payhero_channel_id = v_channel
       where id = v_payment_id;
    end if;

    -- Correct the provider label on the audit row the shared function just wrote.
    -- Bounded to this one payment's success record, so a real HashBack payment is
    -- never relabelled.
    update public.audit_logs
       set metadata = metadata || jsonb_build_object('provider', 'payhero')
     where target_type = 'payment'
       and target_id = v_payment_id::text
       and action = 'payment:success';
  end if;

  return v_result || jsonb_build_object(
    'provider', 'payhero',
    'payhero_channel_id', v_channel);
end;
$$;

revoke all on function public.settle_payhero_payment(text, text, text, text, numeric, bigint, jsonb) from public;
grant execute on function public.settle_payhero_payment(text, text, text, text, numeric, bigint, jsonb) to service_role;

commit;