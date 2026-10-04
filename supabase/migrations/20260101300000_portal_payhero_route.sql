-- PayHero awareness for the captive portal.
--
-- WHY THIS FILE IS NEEDED
-- -----------------------
-- The portal already had a PayHero-capable backend (adapter, STK, callback,
-- verification, settlement). What it did NOT have was a way to REACH it from the
-- captive portal, because portal_create_payment decided its collection path from
-- `payment_provider = 'hashback'` alone. A tenant configured for PayHero therefore
-- fell through to `manual_till` and its customers were told to walk to a Till and
-- send a confirmation code, even though an automated M-Pesa prompt was available.
--
-- So this is a routing change only: it teaches the existing portal entry point
-- about the provider that is already configured. It adds no payment logic, no
-- settlement, no credential handling and no second provider implementation.
--
-- WHAT IS DELIBERATELY UNCHANGED
-- ------------------------------
--   * The HashBack branch keeps exactly the behaviour it had. A HashBack tenant is
--     unaffected.
--   * 'manual' still means manual. An ISP with no automated channel configured is
--     NOT silently switched to PayHero; it keeps its Till flow, because that is
--     what its staff are set up for.
--   * No amount, tenant or channel is accepted as a parameter. Everything still
--     comes from the slug and the plan row.
--   * No table, column or row is dropped. The five historical HashBack payments
--     are not touched.
--
-- SECURITY
-- --------
-- PayHero is an automated provider, so it is held to the automated bar: the
-- tenant must be CONNECTED and must have a channel assigned, exactly as HashBack
-- requires an AccountID. Otherwise this raises and the portal refuses the sale
-- rather than taking money it cannot settle.
-- =============================================================================

begin;

-- ── 1. Teach portal_create_payment about PayHero ───────────────────────────
--
-- Only three things change, and each is the same decision the HashBack branch
-- already makes:
--
--   * readiness  → an automated provider needs connection_status='connected' and
--                  its own channel id (PayHero: payhero_channel_id).
--   * method     → 'mpesa' for any automated provider, 'till_manual' otherwise.
--   * mode       → 'stk' for any automated provider.
--
-- The reference prefix also becomes provider-specific for PayHero, matching what
-- create_payhero_payment mints. That is cosmetic today (both are opaque), but it
-- means an operator reading a reference can tell which pipeline owns it.
create or replace function public.portal_create_payment(
  p_slug     text,
  p_plan_id  uuid,
  p_msisdn   text default null
) returns jsonb
  language plpgsql
  security definer
  set search_path = public as $$
declare
  v_isp    uuid;
  v_plan   public.plans;
  v_cfg    public.isp_payment_configs;
  v_amount numeric;
  v_phone  text;
  v_client public.clients;
  v_inv    public.invoices;
  v_pay    public.payments;
  v_ref    text;
  v_automated boolean;
begin
  -- Resolved in two steps rather than `select i.id, p.*`, because a row
  -- expansion cannot be assigned to a composite variable that way.
  select id into v_isp from public.isps
   where lower(trim(slug)) = lower(trim(p_slug));

  select * into v_plan from public.plans
   where isp_id = v_isp
     and id = p_plan_id
     and is_active;

  if v_isp is null or v_plan.id is null then
    raise exception 'Package not found' using errcode = 'no_data_found';
  end if;

  v_amount := v_plan.price;
  if v_amount is null or v_amount <= 0 then
    raise exception 'That package has no valid price'
      using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_cfg from public.isp_payment_configs where isp_id = v_isp;

  -- One predicate for "this tenant collects automatically", used by every decision
  -- below. Defining it once is what keeps the readiness check, the payment method
  -- and the collection mode from ever disagreeing with each other.
  v_automated := v_cfg.payment_provider::text in ('hashback', 'payhero');

  if v_automated then
    if v_cfg.connection_status::text <> 'connected' then
      raise exception 'This network is not ready to accept payments yet'
        using errcode = 'integrity_constraint_violation';
    end if;
    -- Each automated provider names its destination in its own column. A missing
    -- one means the platform has not assigned the tenant a channel yet, which is a
    -- misconfiguration rather than something the customer can act on.
    if v_cfg.payment_provider::text = 'payhero' and v_cfg.payhero_channel_id is null then
      raise exception 'This network is not ready to accept payments yet'
        using errcode = 'integrity_constraint_violation';
    end if;
    if v_cfg.payment_provider::text = 'hashback' and v_cfg.hashback_account_id is null then
      raise exception 'This network is not ready to accept payments yet'
        using errcode = 'integrity_constraint_violation';
    end if;
  elsif nullif(btrim(coalesce(v_cfg.till_number, '')), '') is null
     and nullif(btrim(coalesce(v_cfg.paybill_number, '')), '') is null then
    -- Neither an automated channel nor a number to pay by hand: there is no way
    -- for this customer to hand over money, so say so rather than pretending.
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

  -- Unique, opaque, derived from a UUID and nothing secret. The prefix names the
  -- pipeline so an operator reading a reference knows who owns it.
  v_ref := case when v_cfg.payment_provider::text = 'payhero'
                then 'ISPFLOW-'
                else 'NETISP-'
           end || replace(extensions.gen_random_uuid()::text, '-', '');

  -- The method records HOW the money is being collected, because the two modes
  -- are settled by different paths: 'till_manual' by confirm_manual_payment,
  -- 'mpesa' by the provider's verified callback. Both leave the row 'pending';
  -- neither grants anything on its own.
  insert into public.payments (
    isp_id, client_id, invoice_id, phone, amount, method, status,
    payment_provider, provider_reference, initiated_at, provider_metadata
  ) values (
    v_isp, v_client.id, v_inv.id, v_phone, v_amount,
    case when v_automated then 'mpesa' else 'till_manual' end,
    'pending',
    v_cfg.payment_provider, v_ref, now(),
    jsonb_build_object('plan_id', v_plan.id,
                       'plan_name', v_plan.name,
                       'source', 'captive_portal',
                       'isp_slug', lower(trim(p_slug)),
                       'collection_mode', case when v_automated then 'stk' else 'manual_till' end)
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
    -- Which provider actually owns this payment, so the Edge Function prompts the
    -- right one and the browser labels the screen correctly.
    'provider', v_cfg.payment_provider::text,
    'collection_mode', case when v_automated then 'stk' else 'manual_till' end,
    -- Only meaningful on the manual path.
    'till_number', v_cfg.till_number,
    'paybill_number', v_cfg.paybill_number,
    'customer_notice', v_cfg.customer_notice,
    -- Server-side only. Never returned to a browser.
    'hashback_account_id', v_cfg.hashback_account_id,
    'payhero_channel_id', v_cfg.payhero_channel_id
  );
end;
$$;

revoke all on function public.portal_create_payment(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.portal_create_payment(text, uuid, text) to service_role;

comment on function public.portal_create_payment(text, uuid, text) is
  'Creates a pending captive-portal payment. Amount, tenant and the provider '
  'channel are resolved from the slug and the plan row; none is accepted as a '
  'parameter. Reports which provider owns the payment so the caller prompts the '
  'right one.';

commit;