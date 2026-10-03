-- =============================================================================
--  Grant the period that was actually paid for, not a fixed 30 days.
--
--  Found by tracing the activation path rather than trusting it.
--
--  settle_hashback_payment() activated a customer with a hardcoded
--
--      expires_at = v_from + interval '30 days'
--
--  but nothing about a payment is 30 days. plans carry duration_hours, and the
--  fixtures show the shortest real offer is '1 Day' (24h) while monthly offers
--  are 720h. So a customer who paid KES 10 for a single day was credited with
--  30 days of service. On a hotspot platform that is the whole product: free
--  service for 29 days, sold at a loss, on every short plan.
--
--  The duration was never available at that point in the function because
--  neither table carries a plan reference:
--
--      invoices  period_label text, plan_name text   (free text, no id, no hours)
--      clients   plan_name text                      (free text, no plan_id)
--
--  so the fix resolves the period from the ISP's own catalogue, in this order:
--
--    1. an exact plan match on the invoice's period_label, within the tenant
--    2. an exact plan match on the invoice's plan_name, within the tenant
--    3. a parsed label ('1 Day', '30 Days', '1 Month') as a fallback
--    4. 30 days, only when nothing above matches
--
--  Every lookup is scoped to the invoice's own isp_id. Two ISPs may both sell a
--  plan called 'Monthly' with different durations, and the grant must follow the
--  tenant that was actually paid, so a plan name can never resolve to another
--  tenant's catalogue.
--
--  Nothing else about settlement changes: same transaction, same duplicate
--  guard, same one-grant-per-transition.
-- =============================================================================

begin;

-- Resolves the hours a payment grants, within one tenant. Returns null when
-- nothing matches, so the caller can decide its own fallback.
create or replace function public.payment_grant_hours(
  p_isp_id uuid,
  p_period_label text,
  p_plan_name text
) returns integer
  language plpgsql stable security definer set search_path = public as $$
declare
  v_hours integer;
begin
  if p_isp_id is null then return null; end if;

  -- 1/2. Exact catalogue match, tenant-scoped. Exact rather than LIKE, so
  -- '1 Day' cannot match '30 Days' and 'Monthly' cannot match 'Monthly Plus'.
  select duration_hours into v_hours
    from public.plans
   where isp_id = p_isp_id
     and duration_hours is not null
     and ( (p_period_label is not null and btrim(p_period_label) <> ''
             and lower(btrim(name)) = lower(btrim(p_period_label)))
        or (p_plan_name is not null and btrim(p_plan_name) <> ''
             and lower(btrim(name)) = lower(btrim(p_plan_name))) )
   order by duration_hours
   limit 1;
  if v_hours is not null then
    return v_hours;
  end if;

  -- 3. Parse the label when the catalogue does not carry it.
  declare
    n numeric;
    unit text;
    base text := lower(coalesce(nullif(btrim(p_period_label), ''),
                                btrim(p_plan_name), ''));
  begin
    if base !~ '^[0-9.]+\s*(hour|day|week|month|year)s?$' then
      return null;
    end if;
    n := split_part(regexp_replace(base, '\s+', ' ', 'g'), ' ', 1)::numeric;
    unit := regexp_replace(base, '^[0-9.]+\s*', '');

    if unit like 'hour%' then        return greatest(round(n)::int, 1);
    elsif unit like 'day%' then      return greatest(round(n * 24)::int, 1);
    elsif unit like 'week%' then     return greatest(round(n * 168)::int, 1);
    elsif unit like 'month%' then    return greatest(round(n * 720)::int, 1);
    elsif unit like 'year%' then     return greatest(round(n * 8760)::int, 1);
    else return null;
    end if;
  exception when others then
    -- A label that looks parseable but is not must not abort settlement. The
    -- caller's fallback is safer than a failed payment.
    return null;
  end;
end;
$$;

revoke all on function public.payment_grant_hours(uuid, text, text) from public;
grant execute on function public.payment_grant_hours(uuid, text, text) to service_role;

comment on function public.payment_grant_hours(uuid, text, text) is
  'Hours a settled payment grants, resolved inside one ISP''s own catalogue. '
  'Never resolves across tenants, and returns NULL rather than guessing.';

commit;

-- =============================================================================
--  settle_hashback_payment, with the period actually paid for.
--
--  The whole body is reproduced because CREATE OR REPLACE cannot amend a
--  statement inside an existing body. Everything except one expression is
--  byte-identical to the applied function: same FOR UPDATE serialisation, same
--  unknown-reference reconciliation, same conflict-before-duplicate ordering,
--  same duplicate short-circuit, same single-transaction completion.
--
--  The one change: the 30-day constant is replaced by the resolved grant.
-- =============================================================================

begin;

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
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_pay       public.payments;
  v_inv       public.invoices;
  v_client    public.clients;
  v_from      timestamptz;
  v_hours     integer;
  v_activated boolean := false;
  v_duplicate boolean := false;
  v_completion jsonb := '{}'::jsonb;
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

  -- Conflict is checked BEFORE the duplicate check, and the order matters.
-- A reference that is already settled but presented with a *different*
  -- provider transaction id is not a redelivery of the same event. It means two
  -- distinct transfers both claim this payment, which is exactly the case an
  -- operator must see. Checking "already success" first would report that as a
  -- harmless duplicate and no reconciliation row would ever be written.
  if v_pay.status = 'success'
     and p_transaction_id is not null
     and v_pay.provider_transaction_id is not null
     and v_pay.provider_transaction_id <> p_transaction_id then
    insert into public.payment_reconciliation (
      provider, provider_reference, provider_transaction_id, amount,
      raw_payload, reason, status
    ) values (
      'hashback', p_reference, p_transaction_id, p_amount,
      coalesce(p_provider_metadata, '{}'::jsonb),
      'reference already settled under a different transaction id', 'conflict'
    );
    return jsonb_build_object(
      'ok', false, 'settled', false, 'duplicate', false,
      'reason', 'transaction_conflict');
  end if;

  -- Already handled. Return success so the provider stops retrying, but change
  -- nothing: no second renewal, no second SMS, no second RADIUS job.
  --
  -- This is the guard that makes a redelivered webhook idempotent, and it must
  -- be set BEFORE any write below. Every write below is conditioned on
  -- `not v_duplicate`, so a provider that delivers the same event five times
  -- activates the customer exactly once. Dropping these two blocks turns every
  -- redelivery into a second activation, a second RADIUS job and a second SMS.
  if v_pay.status = 'success' then
    v_duplicate := true;
  end if;

  if not v_duplicate then
    -- The unique index on provider_transaction_id is the concurrency backstop.
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

  -- â”€â”€ Activation: reuse the existing billing behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        -- THE FIX. The grant is what was sold, resolved inside this tenant's own
        -- catalogue. The previous hardcoded 30 days credited a paying customer
        -- with service they had not bought whenever the plan was shorter.
        v_hours := public.payment_grant_hours(
          v_pay.isp_id, v_inv.period_label, v_inv.plan_name);

        update public.clients set
          status = 'active',
          balance = 0,
          plan_name = coalesce(v_inv.plan_name, plan_name),
          expires_at = v_from + make_interval(hours => coalesce(v_hours, 720))
        where id = v_inv.client_id;

        v_activated := true;
      end if;
    end if;
  end if;

  -- â”€â”€ RADIUS + SMS, only on the transition â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if not v_duplicate then
    v_completion := public.complete_hashback_settlement(v_pay.id, p_reference, p_receipt);
  end if;

  if not v_duplicate then
    insert into public.audit_logs(actor_id, actor_role, isp_id, action, target_type, target_id, metadata)
    values (null, 'super_admin'::platform_role, v_pay.isp_id,
            'payment:success', 'payment', v_pay.id::text,
            jsonb_build_object('amount', v_pay.amount,
                               'reference', p_reference,
                               'transaction_id', p_transaction_id,
                               'receipt', p_receipt,
                               'provider', 'hashback',
                               'grant_hours', v_hours,
                               'radius', v_completion->'radius',
                               'sms', v_completion->'sms'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'settled', not v_duplicate,
    'duplicate', v_duplicate,
    'activated', v_activated,
    'grant_hours', v_hours,
    'payment_id', v_pay.id,
    'isp_id', v_pay.isp_id,
    'completion', v_completion,
    'status', 'success'
  );
end;
$$;

revoke all on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) from public;
grant execute on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) to service_role;

commit;
