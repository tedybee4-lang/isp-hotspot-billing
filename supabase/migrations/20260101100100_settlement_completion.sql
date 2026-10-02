-- =============================================================================
--  Settlement completion: RADIUS synchronisation and payment SMS.
--
--  Added as a separate migration rather than folded into the previous one so the
--  already-applied file is never edited.
--
--  The audited flow up to this point is:
--
--    payment row created (pending)
--      → STK initiated
--      → webhook verified
--      → settle_hashback_payment marks success + reactivates the customer
--                                                            ← ends here today
--
--  Two things are missing after that point, and both are production blockers:
--  the router is never told the customer paid, and the customer is never told.
--
--  Both are added here, on the SAME guarded path as the settlement itself, so a
--  duplicate webhook cannot enqueue a second RADIUS job or send a second SMS.
-- =============================================================================

begin;

-- =============================================================================
--  1. SMS template
--
--  Reuses the existing sms_messages queue and the existing template_key
--  convention. No new SMS provider, no new sending mechanism.
-- =============================================================================

-- sms_templates is tenant-scoped (isp_id is NOT NULL), so a platform template
-- row cannot exist. The payment confirmation is therefore created per ISP, on
-- demand, the first time that ISP settles a payment through HashBack.
--
-- It is a helper rather than inline SQL because the completion function calls it
-- on every settlement and the insert must stay idempotent.
create or replace function public.ensure_payment_sms_template(p_isp_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_isp_id is null then return; end if;

  insert into public.sms_templates (isp_id, key, name, body, is_active)
  values (
    p_isp_id,
    'payment_received',
    'Payment received',
    'Payment of KES {{amount}} received. Your account is active until '
      || '{{expires_at}}. Reference {{reference}}.',
    true
  )
  on conflict do nothing;
end;
$$;

revoke all on function public.ensure_payment_sms_template(uuid) from public;
grant execute on function public.ensure_payment_sms_template(uuid) to service_role;

-- =============================================================================
--  2. Post-settlement activation
--
--  Called from inside settle_hashback_payment, in the same transaction, and
--  only on the pending → success transition.
--
--  Why in the database rather than in the Edge Function:
--
--    * The webhook path and the PULL reconciliation path both settle through the
--      same function, so both get RADIUS and SMS for free. Doing it in the
--      Edge Function would mean implementing it twice and risking the two
--      paths drifting.
--    * One transaction means a failure to enqueue rolls back the settlement
--      rather than leaving a paid customer whose router was never updated.
--    * The "settled AND not yet notified" checks below make it safe against
--      replays without needing any in-memory state.
-- =============================================================================

create or replace function public.complete_hashback_settlement(
  p_payment_id uuid,
  p_reference  text,
  p_receipt    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pay     public.payments;
  v_inv     public.invoices;
  v_client  public.clients;
  v_plan    public.plans;
  v_job_id  uuid;
  v_sms     uuid;
  v_node    uuid;
  v_radius  jsonb := jsonb_build_object('queued', false);
  v_sms_res jsonb := jsonb_build_object('queued', false);
begin
  -- FOR UPDATE: two concurrent replays serialise here, so the second one sees
  -- the first one's effect and does nothing.
  select * into v_pay from public.payments where id = p_payment_id for update;

  if v_pay.id is null then
    raise exception 'Payment not found' using errcode = 'no_data_found';
  end if;

  if v_pay.status <> 'success' then
    -- Never provision from an unsettled payment.
    return jsonb_build_object('ok', false, 'reason', 'payment is not settled');
  end if;

  select * into v_inv from public.invoices where id = v_pay.invoice_id;
  if v_inv.id is null or v_inv.client_id is null then
    -- A package purchase with no invoice has no customer to provision. Not an
    -- error: there is simply nothing to push to a router.
    return jsonb_build_object('ok', true, 'reason', 'nothing to provision');
  end if;

  select * into v_client from public.clients where id = v_inv.client_id;
  if v_client.id is null then
    return jsonb_build_object('ok', true, 'reason', 'customer no longer exists');
  end if;

  -- ── RADIUS synchronisation ───────────────────────────────────────────────
  --
  -- Guarded on both "settled" and "not already synced". A replay finds the
  -- existing mirror row, sees it is no longer 'pending', and skips. That is
  -- what stops a duplicate webhook from extending a customer's RADIUS
  -- attributes twice.
  if not exists (
    select 1 from public.radius_accounts
     where client_id = v_client.id
       and coalesce(sync_state, '') <> 'pending'
  ) then
    -- Which router? The ISP's first enabled router.
    --
    -- Note: `sessions` is Supabase's OAuth session table, not a customer
    -- connection, so it cannot be used to find "the router this customer is on".
    -- The tenant's enabled router list is the only reliable source available
    -- here, and the choice is scoped to this ISP so no tenant can provision onto
    -- another's hardware.
    select n.id into v_node from public.nodes n
     where n.isp_id = v_pay.isp_id and n.enabled
     order by n.created_at
     limit 1;

    if v_node is not null then
      select pl.id into v_plan
        from public.plans pl
       where pl.isp_id = v_pay.isp_id
         and pl.name = v_inv.plan_name
       limit 1;

      -- The RADIUS username follows the convention the platform already uses
      -- for voucher and subscriber identities: NETISP-<account number>. The
      -- router authenticates this; the platform's mirror is keyed on client_id,
      -- so a naming change here would not orphan the record.
      insert into public.router_jobs
        (isp_id, node_id, kind, payload, idempotency_key, priority, max_attempts)
      values (
        v_pay.isp_id,
        v_node,
        'radius_sync',
        jsonb_build_object(
          'client_id', v_client.id,
          'username', 'NETISP-' || replace(v_client.account_no, '-', ''),
          'service', 'hotspot',
          'plan_id', v_plan.id,
          -- The router is told the real, already-extended expiry, so the figure
          -- it enforces is the same one the customer sees.
          'expiry', to_char(v_client.expires_at, 'YYYY-MM-DD HH24:MI:SS'),
          'simultaneous_use', 1,
          -- Carried so a job retry is traceable back to the payment.
          'payment_id', v_pay.id,
          'reference', p_reference
        ),
        -- One pending radius job per customer. A second settlement for the same
        -- customer reuses it rather than queueing a duplicate.
        'radius:' || v_client.id::text,
        1,
        5
      )
      on conflict do nothing
      returning id into v_job_id;

      if v_job_id is not null then
        v_radius := jsonb_build_object('queued', true, 'job_id', v_job_id,
                                       'node_id', v_node);
      end if;
    else
      -- No router at all for this ISP. Recorded rather than silently skipped,
      -- so the panel can say "paid but not provisioned" rather than "active".
      v_radius := jsonb_build_object(
        'queued', false,
        'reason', 'this ISP has no router configured for this customer');
    end if;
  end if;

  -- ── Payment SMS ──────────────────────────────────────────────────────────
  --
  -- Guarded the same way. A duplicate webhook finds the existing message and
  -- sends nothing, so a customer is never told twice about one payment.
  if v_client.phone is not null and not exists (
    select 1 from public.sms_messages
     where client_id = v_client.id
       and template_key = 'payment_received'
       and to_number = v_client.phone
  ) then
    -- Templates are tenant-scoped, so make sure this ISP has one before
    -- referencing it. Idempotent.
    perform public.ensure_payment_sms_template(v_pay.isp_id);

    insert into public.sms_messages (isp_id, client_id, template_key, to_number, body)
    values (
      v_pay.isp_id, v_client.id, 'payment_received', v_client.phone,
      'Payment of KES ' || v_pay.amount::text || ' received. Your account is '
        || 'active until ' || to_char(v_client.expires_at, 'DD Mon YYYY')
        || '. Reference ' || p_reference || '.'
    )
    returning id into v_sms;

    v_sms_res := jsonb_build_object('queued', true, 'message_id', v_sms);
  end if;

  return jsonb_build_object(
    'ok', true,
    'radius', v_radius,
    'sms', v_sms_res,
    'reference', p_reference
  );
end;
$$;

revoke all on function public.complete_hashback_settlement(uuid, text, text) from public;
grant execute on function public.complete_hashback_settlement(uuid, text, text) to service_role;

-- =============================================================================
--  3. Call it from settlement
--
--  settle_hashback_payment is replaced so the post-settlement work happens
--  inside the same transaction as the status change. The body is otherwise
--  identical to the applied version — it is reproduced in full because
--  CREATE OR REPLACE cannot add a statement to an existing body.
--
--  The one behavioural change: on the pending → success transition only, it
--  calls complete_hashback_settlement(). `v_duplicate` still short-circuits
--  everything, so a replay provisions nothing further.
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
  --
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
  if v_pay.status = 'success' then
    v_duplicate := true;
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

  -- ── RADIUS + SMS, only on the transition ──────────────────────────────────
  --
  -- Same transaction, same guard. A duplicate webhook never reaches here with
  -- v_duplicate false, so it can neither queue a second job nor send a second
  -- SMS.
  if not v_duplicate then
    v_completion := public.complete_hashback_settlement(v_pay.id, p_reference, p_receipt);
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
                               'provider', 'hashback',
                               'radius', v_completion->'radius',
                               'sms', v_completion->'sms'));
  end if;

  return jsonb_build_object(
    'ok', true,
    'settled', not v_duplicate,
    'duplicate', v_duplicate,
    'activated', v_activated,
    'payment_id', v_pay.id,
    'isp_id', v_pay.isp_id,
    'completion', v_completion,
    'status', 'success'
  );
end;
$$;

revoke all on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) from public;
grant execute on function public.settle_hashback_payment(text, text, text, text, text, text, numeric, text, jsonb) to service_role;

-- =============================================================================
--  4. Reconciliation queue visibility
--
--  The support screen needs to know what is waiting for a human without reading
--  the table directly. Resolved server-side; no isp_id is accepted.
-- =============================================================================

create or replace function public.my_reconciliation_queue(limit_rows integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  -- A super admin reviews the whole platform's queue; a tenant sees only its
  -- own, resolved here from the caller's profile rather than from a parameter.
  if public.is_super_admin() then
    return coalesce(
      (select jsonb_agg(to_jsonb(r) order by r.created_at desc)
         from (
           select * from public.payment_reconciliation
            where status in ('unmatched','conflict','pending_review')
            order by created_at desc
            limit greatest(least(coalesce(limit_rows, 50), 200), 1)
         ) r),
      '[]'::jsonb);
  end if;

  return coalesce(
    (select jsonb_agg(to_jsonb(r) order by r.created_at desc)
       from (
         select * from public.payment_reconciliation
          where isp_id = public.current_isp_id()
            and status in ('unmatched','conflict','pending_review')
          order by created_at desc
          limit greatest(least(coalesce(limit_rows, 50), 200), 1)
       ) r),
    '[]'::jsonb);
end;
$$;

revoke all on function public.my_reconciliation_queue(integer) from public;
grant execute on function public.my_reconciliation_queue(integer) to authenticated;

commit;