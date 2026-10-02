-- =============================================================================
--  Tenant metrics — every number on the ISP dashboard comes from here.
--  No hardcoded statistics anywhere in the app.
-- =============================================================================

create or replace view public.isp_dashboard_stats
with (security_invoker = on) as
select
  i.id as isp_id,

  -- Customers
  (select count(*)::int from public.clients c
     where c.isp_id = i.id)                                        as total_customers,
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'active')                as active_customers,
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'expired')                as expired_customers,
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'suspended')              as suspended_customers,
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'pending')                as pending_customers,

  -- Expiring within 7 days (and not already expired)
  (select count(*)::int from public.clients c
     where c.isp_id = i.id and c.status = 'active'
       and c.expires_at is not null
       and c.expires_at between now() and now() + interval '7 days') as expiring_soon,

  -- New this month
  (select count(*)::int from public.clients c
     where c.isp_id = i.id
       and c.created_at >= date_trunc('month', now()))            as new_customers_month,

  -- Service accounts by type
  (select count(*)::int from public.service_accounts s
     where s.isp_id = i.id and s.service_type = 'hotspot')         as hotspot_accounts,
  (select count(*)::int from public.service_accounts s
     where s.isp_id = i.id and s.service_type = 'pppoe')           as pppoe_accounts,

  -- Live sessions (ended_at IS NULL)
  (select count(*)::int from public.sessions s
     where s.isp_id = i.id and s.ended_at is null)                 as online_now,
  (select count(*)::int from public.sessions s
     where s.isp_id = i.id and s.ended_at is null
       and s.mac_address is not null)                              as hotspot_online,

  -- Routers
  (select count(*)::int from public.nodes n where n.isp_id = i.id)  as routers_total,
  (select count(*)::int from public.nodes n
     where n.isp_id = i.id and n.status = 'online')                 as routers_online,
  (select count(*)::int from public.nodes n
     where n.isp_id = i.id and n.status = 'offline')                as routers_offline,
  -- Heartbeats older than 5 minutes are treated as offline
  (select count(*)::int from public.nodes n
     where n.isp_id = i.id and n.status <> 'offline'
       and (n.last_seen is null or n.last_seen < now() - interval '5 minutes'))
                                                                    as routers_stale,

  -- Revenue
  (select coalesce(sum(p.amount), 0)::numeric(14,2) from public.payments p
     where p.isp_id = i.id and p.status = 'success'
       and p.created_at::date = current_date)                      as revenue_today,
  (select coalesce(sum(p.amount), 0)::numeric(14,2) from public.payments p
     where p.isp_id = i.id and p.status = 'success'
       and p.created_at >= date_trunc('month', now()))            as revenue_month,
  (select coalesce(sum(p.amount), 0)::numeric(14,2) from public.payments p
     where p.isp_id = i.id and p.status = 'success'
       and p.created_at >= now() - interval '30 days')             as revenue_30d,

  -- Payments by state
  (select count(*)::int from public.payments p
     where p.isp_id = i.id and p.status = 'pending')                as payments_pending,
  (select count(*)::int from public.payments p
     where p.isp_id = i.id and p.status = 'failed')                 as payments_failed,
  (select count(*)::int from public.payments p
     where p.isp_id = i.id and p.status = 'reversed')               as payments_reversed,

  -- Receivables
  (select coalesce(sum(v.amount), 0)::numeric(14,2) from public.invoices v
     where v.isp_id = i.id and v.status in ('unpaid','overdue'))    as outstanding,
  (select count(*)::int from public.invoices v
     where v.isp_id = i.id and v.status = 'overdue')                as invoices_overdue,

  -- Vouchers
  (select count(*)::int from public.vouchers v
     where v.isp_id = i.id)                                         as vouchers_total,
  (select count(*)::int from public.vouchers v
     where v.isp_id = i.id and v.status = 'unused')                 as vouchers_unused,
  (select count(*)::int from public.vouchers v
     where v.isp_id = i.id and v.status = 'expired')                as vouchers_expired,

  -- Packages
  (select count(*)::int from public.plans p
     where p.isp_id = i.id and p.is_active)                         as packages_active,

  -- Business
  (select coalesce(sum(e.amount), 0)::numeric(14,2) from public.expenses e
     where e.isp_id = i.id and e.date >= date_trunc('month', now())) as expenses_month,
  (select count(*)::int from public.resellers r
     where r.isp_id = i.id and r.status = 'active')                as resellers_active,
  (select coalesce(sum(c.amount), 0)::numeric(14,2) from public.commissions c
     where c.isp_id = i.id and c.status in ('pending','approved'))   as commissions_due,
  (select count(*)::int from public.sms_messages m
     where m.isp_id = i.id and m.created_at >= date_trunc('month', now()))
                                                                    as sms_month,
  (select count(*)::int from public.inventory_items it
     where it.isp_id = i.id and it.quantity <= it.reorder_level)    as inventory_low,

  (select count(*)::int from public.tickets t
      where t.isp_id = i.id and t.status in ('open','in_progress')) as tickets_open,
  (select count(*)::int from public.tickets t
      where t.isp_id = i.id and t.status = 'resolved')           as tickets_resolved
from public.isps i;

-- =============================================================================
--  Recent activity feed (tenant-scoped)
-- =============================================================================
-- ── Recent activity feed (tenant-scoped) ────────────────────────────────────
create or replace view public.isp_recent_activity
with (security_invoker = on) as
select * from (
  select
    'payment'::text as kind, p.created_at,
    p.isp_id, p.id as ref,
    coalesce(c.full_name, 'Customer') as subject,
    ('Payment of KES ' || p.amount::text) as detail
  from public.payments p
  left join public.clients c on c.id = p.client_id

  union all
  select
    'customer', c.created_at, c.isp_id, c.id, c.full_name,
    'New customer registered (' || c.account_no || ')'
  from public.clients c

  union all
  select
    'invoice', v.created_at, v.isp_id, v.id, v.invoice_no,
    'Invoice issued — KES ' || v.amount::text
  from public.invoices v

  union all
  select
    'voucher', vc.created_at, vc.isp_id, vc.id, vc.code,
    'Voucher generated'
  from public.vouchers vc

  union all
  select
    'renewal', r.created_at, r.isp_id, r.id, coalesce(r.note, 'Renewal'),
    'Service renewed'
  from public.renewals r

  union all
  select
    'expense', e.created_at, e.isp_id, e.id, coalesce(e.supplier, e.category),
    'Expense of KES ' || e.amount::text
  from public.expenses e
) a;

-- =============================================================================
--  Cross-tenant denial — the guarantee, expressed in the database.
--
--  Nothing in the app passes isp_id for a read. Even if a caller tried
--  `?isp_id=<someone else>` or posted a foreign id, this function ignores it
--  and always uses the tenant from the authenticated profile. Passing a
--  foreign id therefore returns the caller's OWN row or nothing at all —
--  it can never surface another ISP's data.
-- =============================================================================

create or replace function public.assert_same_tenant(p_isp_id uuid)
  returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_mine uuid := public.current_isp_id();
begin
  if public.is_super_admin() then
    return p_isp_id;              -- platform operator may target any tenant
  end if;
  if v_mine is null then
    raise exception 'No ISP membership';
  end if;
  if p_isp_id is not null and p_isp_id <> v_mine then
    raise exception 'Cross-tenant access denied';
  end if;
  return v_mine;                   -- always the caller's own tenant
end;
$$;

grant execute on function public.assert_same_tenant(uuid) to authenticated;

-- Records an ISP-level audit entry. The tenant is ALWAYS derived server-side.
create or replace function public.log_isp_action(
  p_action text,
  p_target_type text default null,
  p_target_id   text default null,
  p_metadata    jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs
    (actor_id, actor_role, isp_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    (select role from public.profiles where id = auth.uid()),
    public.current_isp_id(),
    p_action, p_target_type, p_target_id, p_metadata
  );
$$;

grant execute on function public.log_isp_action(text, text, text, jsonb) to authenticated;

-- ── SMS: queue a message for the tenant's provider ──────────────────────────
-- The message is always filed under the caller's own tenant.
create or replace function public.queue_sms(
  p_to text, p_body text,
  p_client_id uuid default null,
  p_template_key text default null
) returns public.sms_messages
  language plpgsql security definer set search_path = public as $$
declare
  v_isp uuid := public.assert_same_tenant(null);
  v_msg public.sms_messages;
begin
  if not public.has_permission('sms.send') and not public.can_write_tenant() then
    raise exception 'You do not have permission to send SMS';
  end if;

  insert into public.sms_messages (isp_id, client_id, template_key, to_number, body)
  values (v_isp, p_client_id, p_template_key, p_to, p_body)
  returning * into v_msg;

  perform public.log_isp_action('sms:queued', 'sms', v_msg.id::text,
                                jsonb_build_object('to', p_to));
  return v_msg;
end;
$$;

grant execute on function public.queue_sms(text, text, uuid, text) to authenticated;

-- ── Reseller sale → commission ───────────────────────────────────────────────
-- Commission is calculated from the reseller's own rate, in the caller's tenant.
create or replace function public.record_reseller_sale(
  p_client_id uuid,
  p_invoice_id uuid,
  p_amount numeric
) returns public.commissions
  language plpgsql security definer set search_path = public as $$
declare
  v_isp      uuid := public.assert_same_tenant(null);
  v_client   public.clients;
  v_reseller public.resellers;
  v_comm     public.commissions;
begin
  if not public.can_write_tenant() then
    raise exception 'Not authorised';
  end if;

  select * into v_client from public.clients where id = p_client_id and isp_id = v_isp;
  if v_client.id is null then raise exception 'Customer not found in this ISP'; end if;
  if v_client.reseller_id is null then raise exception 'Customer has no reseller'; end if;

  select * into v_reseller from public.resellers where id = v_client.reseller_id and isp_id = v_isp;
  if v_reseller.id is null then raise exception 'Reseller not found in this ISP'; end if;

  insert into public.commissions (isp_id, reseller_id, payment_id, sale_amount, rate, amount, period)
  values (
    v_isp, v_reseller.id, p_invoice_id, p_amount,
    v_reseller.commission_rate,
    round(p_amount * v_reseller.commission_rate / 100, 2),
    to_char(now(), 'YYYY-MM')
  )
  returning * into v_comm;

  perform public.log_isp_action('commission:created', 'commission', v_comm.id::text,
    jsonb_build_object('amount', v_comm.amount, 'reseller', v_reseller.code));
  return v_comm;
end;
$$;

grant execute on function public.record_reseller_sale(uuid, uuid, numeric) to authenticated;
