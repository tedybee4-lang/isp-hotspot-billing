/**
 * ISP panel sections that render straight from tenant data.
 *
 * No hardcoded statistics anywhere: every figure comes from the
 * `isp_dashboard_stats` view or from the tenant's own rows.
 */
import { useState } from 'react'
import {
  Users, CreditCard, Receipt, RefreshCw, MessageSquare, Package, Percent,
  Wallet, Boxes, Ticket as TicketIcon, Radio as RadioIcon,
} from 'lucide-react'
import { useTenant } from '../../../context/TenantContext'
import * as api from '../../../lib/data'
import { usePanel } from '../../../context/PanelContext'
import { useAuth } from '../../../context/AuthContext'
import { ResourcePage, Money, When, StatusCell, type Column } from '../../../components/ui/ResourcePage'
import { Card, CardHeader, StatTile, EmptyState, Spinner, Button, Alert, Badge, inputClass } from '../../../components/ui'
import type {
  Client, Commission, Expense, InventoryItem, Invoice, Payment,
  Reseller, Session as NetSession, SmsMessage, Voucher,
} from '../../../lib/types'

const kes = (n: number | string | null) =>
  `KES ${Number(n ?? 0).toLocaleString('en', { maximumFractionDigits: 0 })}`

// -- Dashboard ----------------------------------------------------------------
export function DashboardPage() {
  const { stats, loading, error, reload } = usePanel()
  const { clients, sessions } = useTenant()
  const { user } = useAuth()

  if (loading) return <Spinner label="Loading your dashboard..." />
  if (error) return <Card className="p-5"><Alert kind="error">{error}</Alert></Card>
  if (!stats) return (
    <Card className="p-8">
      <EmptyState title="No data yet" hint="Add your first customer to populate the dashboard." />
    </Card>
  )

  const expiring = clients
    .filter((c) => c.status === 'active' && c.expires_at)
    .sort((a, b) => (a.expires_at ?? '').localeCompare(b.expires_at ?? ''))
    .slice(0, 6)
  const live = sessions.filter((s) => !s.ended_at)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          {user?.isp?.name ?? 'Dashboard'}
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Live figures for this ISP only. Nothing here is estimated.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Total customers" value={stats.total_customers} icon={<Users className="w-5 h-5" />} tone="violet" hint={`${stats.new_customers_month} new this month`} />
        <StatTile label="Active customers" value={stats.active_customers} icon={<Users className="w-5 h-5" />} tone="emerald" hint={`${stats.expiring_soon} expiring within 7 days`} />
        <StatTile label="Online right now" value={stats.online_now} icon={<RadioIcon className="w-5 h-5" />} tone="sky" hint={`${stats.hotspot_online} hotspot sessions`} />
        <StatTile label="Expiring soon" value={stats.expiring_soon} icon={<RefreshCw className="w-5 h-5" />} tone={stats.expiring_soon > 0 ? 'amber' : 'slate'} hint="Within the next 7 days" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Today's revenue" value={kes(stats.revenue_today)} icon={<CreditCard className="w-5 h-5" />} tone="emerald" />
        <StatTile label="This month" value={kes(stats.revenue_month)} icon={<CreditCard className="w-5 h-5" />} tone="violet" hint={`30-day ${kes(stats.revenue_30d)}`} />
        <StatTile label="Pending payments" value={stats.payments_pending} icon={<Receipt className="w-5 h-5" />} tone="amber" />
        <StatTile label="Outstanding" value={kes(stats.outstanding)} icon={<Wallet className="w-5 h-5" />} tone="rose" hint={`${stats.invoices_overdue} overdue`} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Routers online" value={`${stats.routers_online}/${stats.routers_total}`} icon={<RadioIcon className="w-5 h-5" />} tone={stats.routers_offline > 0 ? 'amber' : 'emerald'} hint={`${stats.routers_offline} offline`} />
        <StatTile label="HotSpot accounts" value={stats.hotspot_accounts} icon={<Package className="w-5 h-5" />} tone="sky" />
        <StatTile label="PPPoE accounts" value={stats.pppoe_accounts} icon={<Package className="w-5 h-5" />} tone="violet" />
        <StatTile label="Open tickets" value={stats.tickets_open} icon={<TicketIcon className="w-5 h-5" />} tone={stats.tickets_open > 0 ? 'amber' : 'slate'} />
      </div>

      {(stats.routers_stale > 0 || stats.routers_offline > 0) && (
        <Alert kind="error">
          {stats.routers_offline > 0 && <>{stats.routers_offline} router(s) offline. </>}
          {stats.routers_stale > 0 && <>{stats.routers_stale} router(s) not reporting a heartbeat.</>}
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Customers expiring soon" subtitle="Next on the renewal list" icon={<RefreshCw className="w-4 h-4" />} />
          {expiring.length === 0
            ? <EmptyState title="Nothing expiring" hint="No active customer expires in the next week." />
            : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {expiring.map((c) => (
                  <li key={c.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 dark:text-white truncate">{c.full_name}</p>
                      <p className="text-[10px] text-slate-400 font-mono">{c.account_no} � {c.plan_name}</p>
                    </div>
                    <When value={c.expires_at} />
                  </li>
                ))}
              </ul>
            )}
        </Card>

        <Card>
          <CardHeader title="Live sessions" subtitle={`${stats.online_now} connected`} icon={<RadioIcon className="w-4 h-4" />} />
          {live.length === 0
            ? <EmptyState title="Nobody online" hint="Active sessions appear here as customers connect." />
            : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {live.slice(0, 6).map((s) => (
                  <li key={s.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-800 dark:text-white truncate">{s.device_type ?? 'Unknown device'}</p>
                      <p className="text-[10px] text-slate-400 font-mono">{s.ip_address ?? '--'}</p>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {((s.downloaded_mb + s.uploaded_mb) / 1024).toFixed(1)} MB
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </Card>
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => void reload()} icon={<RefreshCw className="w-3.5 h-3.5" />}>
          Refresh
        </Button>
      </div>
    </div>
  )
}

// -- Customers ----------------------------------------------------------------
export function CustomersPage() {
  const { clients, plans, loading, setClientStatus, addClient } = useTenant()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', plan_name: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  async function createCustomer(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    // Validate before the round trip so the ISP gets an immediate, specific
    // reason rather than a generic database error.
    if (!form.full_name.trim()) return setFormError('A customer name is required.')
    if (!form.phone.trim()) return setFormError('A phone number is required.')
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) {
      return setFormError('That email address does not look valid.')
    }
    if (!form.plan_name.trim()) return setFormError('Choose a package for this customer.')

    setAdding(true)
    try {
      await addClient({
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        plan_name: form.plan_name.trim(),
      })
      setNotice({ ok: true, text: `${form.full_name.trim()} added.` })
      setForm({ full_name: '', phone: '', email: '', plan_name: '' })
      setAdding(false)
    } catch (err) {
      // Say what actually happened. A failed insert must never read as success.
      setFormError(err instanceof Error ? err.message : 'Could not add that customer.')
    } finally {
      setAdding(false)
    }
  }

  /**
   * Activates or suspends one customer.
   *
   * The control offers the transition that actually applies rather than a
   * free-text status, so the UI cannot request a state the backend never
   * agreed to. A pending customer has no package to act on yet.
   */
  async function toggleStatus(c: Client) {
    const next = c.status === 'suspended' ? 'active' : 'suspended'
    setBusyId(c.id)
    setNotice(null)
    try {
      await setClientStatus(c.id, next)
      setNotice({
        ok: true,
        text: `${c.full_name} ${next === 'active' ? 'reactivated' : 'suspended'}.`,
      })
    } catch (err) {
      setNotice({
        ok: false,
        text: err instanceof Error ? err.message : `Could not update ${c.full_name}.`,
      })
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<Client>[] = [
    { key: 'name', header: 'Customer', sort: (c) => c.full_name,
      cell: (c) => (<div><p className="font-bold text-slate-800 dark:text-white">{c.full_name}</p><p className="text-[10px] text-slate-400 font-mono">{c.account_no}</p></div>) },
    { key: 'phone', header: 'Phone', sort: (c) => c.phone, cell: (c) => <span className="font-mono">{c.phone}</span> },
    { key: 'email', header: 'Email', sort: (c) => c.email ?? '', cell: (c) => <span className="text-slate-400">{c.email ?? '--'}</span> },
    { key: 'plan', header: 'Package', sort: (c) => c.plan_name ?? '', cell: (c) => c.plan_name ?? '--' },
    { key: 'bandwidth', header: 'Bandwidth', cell: (c) => <span className="font-mono text-[10px]">{c.bandwidth ?? '--'}</span> },
    { key: 'expiry', header: 'Expiry', sort: (c) => c.expires_at ?? '', cell: (c) => <When value={c.expires_at} /> },
    { key: 'status', header: 'Status', sort: (c) => c.status, cell: (c) => <StatusCell value={c.status} /> },
    { key: 'balance', header: 'Balance', sort: (c) => Number(c.balance), cell: (c) => <Money value={c.balance} /> },
    {
      key: 'manage',
      header: 'Manage',
      cell: (c) => (
        <Button
          size="sm"
          disabled={busyId === c.id || c.status === 'pending'}
          onClick={() => void toggleStatus(c)}
        >
          {busyId === c.id
            ? 'Saving...'
            : c.status === 'suspended' ? 'Reactivate' : 'Suspend'}
        </Button>
      ),
    },
  ]
return (
    <div className="space-y-4">
      {notice && <Alert kind={notice.ok ? 'success' : 'error'}>{notice.text}</Alert>}

      {adding && (
        <Card>
          <form onSubmit={(e) => void createCustomer(e)} className="p-4 space-y-3">
            <h2 className="text-sm font-black text-slate-900 dark:text-white">New customer</h2>
            {formError && <Alert kind="error">{formError}</Alert>}
            <div className="grid sm:grid-cols-2 gap-3">
              <input aria-label="Customer name" placeholder="Full name"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className={inputClass} />
              <input aria-label="Phone" placeholder="Phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputClass} />
              <input aria-label="Email" type="email" placeholder="Email (optional)"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={inputClass} />
              <select aria-label="Package" value={form.plan_name}
                onChange={(e) => setForm({ ...form, plan_name: e.target.value })}
                className={inputClass}>
                <option value="">Select a package...</option>
                {plans.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={adding}>
                {adding ? 'Saving...' : 'Add customer'}
              </Button>
              <Button size="sm" type="button"
                onClick={() => { setAdding(false); setFormError(null) }}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <ResourcePage
        title="Customers" subtitle={`${clients.length} records for this ISP`}
        icon={<Users className="w-5 h-5" />} rows={clients} columns={columns}
        rowKey={(c) => c.id} loading={loading}
        statusField="status" statusOptions={['active', 'expired', 'suspended', 'pending']}
        searchFields={(c) => [c.full_name, c.phone, c.email ?? '', c.account_no, c.plan_name ?? '']}
        emptyTitle="No customers yet"
        emptyHint={adding ? undefined : 'Add your first customer to get started.'}
        actions={adding ? undefined : (
          <Button size="sm"
            onClick={() => { setAdding(true); setFormError(null); setNotice(null) }}>
            Add customer
          </Button>
        )}
      />
    </div>
  )
}

// -- Payments -----------------------------------------------------------------
export function PaymentsPage() {
  const { payments, loading } = usePanel()
  const columns: Column<Payment>[] = [
    { key: 'amount', header: 'Amount', sort: (p) => Number(p.amount), cell: (p) => <Money value={p.amount} /> },
    { key: 'method', header: 'Method', cell: (p) => <span className="font-mono text-[10px] uppercase">{p.method}</span> },
    { key: 'phone', header: 'Phone', cell: (p) => <span className="font-mono">{p.phone ?? '--'}</span> },
    { key: 'receipt', header: 'Reference', cell: (p) => <span className="font-mono text-[10px] text-slate-400">{p.mpesa_receipt ?? p.checkout_request_id ?? '--'}</span> },
    { key: 'status', header: 'Status', sort: (p) => p.status, cell: (p) => <StatusCell value={p.status} /> },
    { key: 'date', header: 'Date', sort: (p) => p.created_at, cell: (p) => <When value={p.created_at} /> },
  ]
  return (
    <ResourcePage
      title="Payments" subtitle="Every transaction recorded for this ISP"
      icon={<CreditCard className="w-5 h-5" />} rows={payments} columns={columns}
      rowKey={(p) => p.id} loading={loading}
      statusField="status" statusOptions={['success', 'pending', 'failed', 'reversed']}
      searchFields={(p) => [p.phone ?? '', p.mpesa_receipt ?? '', p.checkout_request_id ?? '', p.method]}
      emptyTitle="No payments yet"
    />
  )
}

// -- Invoices -----------------------------------------------------------------
export function InvoicesPage() {
  const { invoices, loading } = useTenant()
  const columns: Column<Invoice>[] = [
    { key: 'no', header: 'Invoice', sort: (i) => i.invoice_no, cell: (i) => <span className="font-mono text-[11px] font-bold">{i.invoice_no}</span> },
    { key: 'period', header: 'Period', sort: (i) => i.period_label, cell: (i) => i.period_label },
    { key: 'plan', header: 'Package', cell: (i) => i.plan_name ?? '--' },
    { key: 'amount', header: 'Amount', sort: (i) => Number(i.amount), cell: (i) => <Money value={i.amount} /> },
    { key: 'due', header: 'Due', sort: (i) => i.due_date, cell: (i) => <When value={i.due_date} /> },
    { key: 'status', header: 'Status', sort: (i) => i.status, cell: (i) => <StatusCell value={i.status} /> },
  ]
  return (
    <ResourcePage
      title="Invoices" icon={<Receipt className="w-5 h-5" />}
      rows={invoices} columns={columns} rowKey={(i) => i.id} loading={loading}
      statusField="status" statusOptions={['paid', 'unpaid', 'overdue', 'cancelled']}
      searchFields={(i) => [i.invoice_no, i.period_label, i.plan_name ?? '']}
      emptyTitle="No invoices yet"
    />
  )
}

// -- Sessions -----------------------------------------------------------------
export function SessionsPage() {
  const { sessions, loading } = useTenant()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Asks the router to drop the customer, then reports what actually happened.
   * A session closed in the database while the router still has the subscriber
   * online is not the same thing as a disconnection, so the two outcomes are
   * distinguished rather than merged into a generic success message.
   */
  async function disconnect(id: string) {
    setBusy(id)
    setNotice(null)
    try {
      const r = await api.kickSession(id)
      setNotice({ ok: Boolean(r.removedOnRouter || r.alreadyEnded), text: r.message })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'Could not disconnect.' })
    } finally {
      setBusy(null)
    }
  }

  const columns: Column<NetSession>[] = [
    { key: 'device', header: 'Device', sort: (s) => s.device_type ?? '', cell: (s) => s.device_type ?? 'Unknown' },
    { key: 'ip', header: 'IP', cell: (s) => <span className="font-mono text-[10px]">{s.ip_address ?? '--'}</span> },
    { key: 'mac', header: 'MAC', cell: (s) => <span className="font-mono text-[10px]">{s.mac_address ?? '--'}</span> },
    { key: 'voucher', header: 'Voucher', cell: (s) => <span className="font-mono text-[10px]">{s.voucher_code ?? '--'}</span> },
    { key: 'down', header: 'Download', sort: (s) => Number(s.downloaded_mb), cell: (s) => <span className="font-mono text-[10px]">{(Number(s.downloaded_mb) / 1024).toFixed(1)} MB</span> },
    { key: 'up', header: 'Upload', sort: (s) => Number(s.uploaded_mb), cell: (s) => <span className="font-mono text-[10px]">{(Number(s.uploaded_mb) / 1024).toFixed(1)} MB</span> },
    { key: 'start', header: 'Started', sort: (s) => s.started_at, cell: (s) => <When value={s.started_at} /> },
    { key: 'action', header: '', cell: (s) => (
      <button onClick={() => void disconnect(s.id)} disabled={busy === s.id}
        className="text-[11px] font-bold text-rose-600 hover:underline disabled:opacity-40">
        {busy === s.id ? 'Disconnecting...' : 'Disconnect'}
      </button>
    ) },
  ]
  return (
    <div className="space-y-4">
      {notice && (
        <Alert kind={notice.ok ? 'success' : 'error'}>
          {notice.ok
            ? notice.text
            : `${notice.text} The customer may still be online until the router accepts the request.`}
        </Alert>
      )}
      <ResourcePage
        title="Active Sessions" icon={<RadioIcon className="w-5 h-5" />}
        rows={sessions.filter((s) => !s.ended_at)} columns={columns}
        rowKey={(s) => s.id} loading={loading}
        searchFields={(s) => [s.device_type ?? '', s.ip_address ?? '', s.mac_address ?? '', s.voucher_code ?? '']}
        emptyTitle="No active sessions" emptyHint="Sessions appear when customers connect to a router."
      />
    </div>
  )
}

// -- Vouchers -----------------------------------------------------------------
export function VouchersPage() {
  const { vouchers, plans, loading, generateVouchers } = useTenant()
  const planName = (id: string | null) => plans.find((p) => p.id === id)?.name ?? '--'
  const columns: Column<Voucher>[] = [
    { key: 'code', header: 'Code', sort: (v) => v.code, cell: (v) => <span className="font-mono font-bold text-[11px]">{v.code}</span> },
    { key: 'plan', header: 'Package', sort: (v) => planName(v.plan_id), cell: (v) => planName(v.plan_id) },
    { key: 'expires', header: 'Expires', sort: (v) => v.expires_at ?? '', cell: (v) => <When value={v.expires_at} /> },
    { key: 'status', header: 'Status', sort: (v) => v.status, cell: (v) => <StatusCell value={v.status} /> },
    { key: 'created', header: 'Generated', sort: (v) => v.created_at, cell: (v) => <When value={v.created_at} /> },
  ]
  const firstPlan = plans[0]?.id
  return (
    <ResourcePage
      title="Vouchers" subtitle={`${vouchers.length} vouchers � all belong to this ISP`}
      icon={<Package className="w-5 h-5" />} rows={vouchers} columns={columns}
      rowKey={(v) => v.id} loading={loading}
      statusField="status" statusOptions={['unused', 'active', 'expired', 'disabled']}
      searchFields={(v) => [v.code, planName(v.plan_id)]}
      emptyTitle="No vouchers yet"
      actions={firstPlan ? (
        <Button size="sm" onClick={() => void generateVouchers(firstPlan, 'VCH', 10)}>
          Generate 10
        </Button>
      ) : undefined}
    />
  )
}

// __SPLIT__

// -- SMS ----------------------------------------------------------------------
export function SmsPage() {
  const { smsMessages, smsTemplates, loading } = usePanel()
  const columns: Column<SmsMessage>[] = [
    { key: 'to', header: 'To', sort: (m) => m.to_number, cell: (m) => <span className="font-mono">{m.to_number}</span> },
    { key: 'template', header: 'Template', sort: (m) => m.template_key ?? '', cell: (m) => <span className="font-mono text-[10px]">{m.template_key ?? '--'}</span> },
    { key: 'body', header: 'Message', cell: (m) => <span className="text-slate-400 line-clamp-1">{m.body}</span> },
    { key: 'status', header: 'Status', sort: (m) => m.status, cell: (m) => <StatusCell value={m.status} /> },
    { key: 'provider', header: 'Provider', cell: (m) => <span className="font-mono text-[10px] text-slate-400">{m.provider ?? '--'}</span> },
    { key: 'segments', header: 'Segments', sort: (m) => Number(m.segments ?? 0), cell: (m) => <span className="font-mono text-[10px]">{m.segments ?? '--'}</span> },
    { key: 'sent', header: 'Sent', sort: (m) => m.sent_at ?? m.created_at, cell: (m) => <When value={m.sent_at ?? m.created_at} /> },
  ]
  return (
    <div className="space-y-6">
      <ResourcePage
        title="SMS" subtitle={`${smsTemplates.length} templates � ${smsMessages.length} messages`}
        icon={<MessageSquare className="w-5 h-5" />} rows={smsMessages} columns={columns}
        rowKey={(m) => m.id} loading={loading}
        statusField="status" statusOptions={['queued', 'sent', 'delivered', 'failed']}
        searchFields={(m) => [m.to_number, m.body, m.template_key ?? '']}
        emptyTitle="No SMS sent yet"
        emptyHint="Configure an SMS provider in Settings to start delivering messages."
      />
      <Card>
        <CardHeader title="Templates" subtitle="Per-ISP message templates" icon={<MessageSquare className="w-4 h-4" />} />
        {smsTemplates.length === 0
          ? <EmptyState title="No templates" hint="Seed templates are created with each ISP." />
          : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {smsTemplates.map((t) => (
                <li key={t.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-bold text-slate-800 dark:text-white">{t.name}</p>
                    <span className="font-mono text-[10px] text-slate-400">{t.key}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{t.body}</p>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  )
}

// -- Resellers & commissions --------------------------------------------------
export function ResellersPage() {
  const { resellers, commissions, loading } = usePanel()
  const revenueByReseller = (id: string) =>
    commissions.filter((c) => c.reseller_id === id).reduce((s, c) => s + Number(c.amount), 0)

  const columns: Column<Reseller>[] = [
    { key: 'code', header: 'Code', sort: (r) => r.code, cell: (r) => <span className="font-mono font-bold text-[11px]">{r.code}</span> },
    { key: 'name', header: 'Reseller', sort: (r) => r.full_name, cell: (r) => <div><p className="font-bold text-slate-800 dark:text-white">{r.full_name}</p><p className="text-[10px] text-slate-400 font-mono">{r.phone ?? '--'}</p></div> },
    { key: 'rate', header: 'Rate', sort: (r) => Number(r.commission_rate), cell: (r) => <span className="font-mono font-bold">{r.commission_rate}%</span> },
    { key: 'earnings', header: 'Commission earned', sort: (r) => revenueByReseller(r.id), cell: (r) => <Money value={revenueByReseller(r.id)} /> },
    { key: 'limit', header: 'Credit limit', sort: (r) => Number(r.credit_limit), cell: (r) => <Money value={r.credit_limit} /> },
    { key: 'status', header: 'Status', sort: (r) => r.status, cell: (r) => <StatusCell value={r.status} /> },
  ]
  return (
    <ResourcePage
      title="Resellers" subtitle={`${resellers.length} resellers � ${commissions.length} commission records`}
      icon={<Users className="w-5 h-5" />} rows={resellers} columns={columns}
      rowKey={(r) => r.id} loading={loading}
      statusField="status" statusOptions={['active', 'suspended']}
      searchFields={(r) => [r.code, r.full_name, r.phone ?? '', r.email ?? '']}
      emptyTitle="No resellers yet"
    />
  )
}

export function CommissionsPage() {
  const { commissions, loading } = usePanel()
  const columns: Column<Commission>[] = [
    { key: 'sale', header: 'Sale amount', sort: (c) => Number(c.sale_amount), cell: (c) => <Money value={c.sale_amount} /> },
    { key: 'rate', header: 'Rate', sort: (c) => Number(c.rate), cell: (c) => <span className="font-mono">{c.rate}%</span> },
    { key: 'amount', header: 'Commission', sort: (c) => Number(c.amount), cell: (c) => <Money value={c.amount} /> },
    { key: 'period', header: 'Period', sort: (c) => c.period, cell: (c) => <span className="font-mono text-[10px]">{c.period}</span> },
    { key: 'status', header: 'Status', sort: (c) => c.status, cell: (c) => <StatusCell value={c.status} /> },
    { key: 'date', header: 'Created', sort: (c) => c.created_at, cell: (c) => <When value={c.created_at} /> },
  ]
  return (
    <ResourcePage
      title="Commissions" icon={<Percent className="w-5 h-5" />}
      rows={commissions} columns={columns} rowKey={(c) => c.id} loading={loading}
      statusField="status" statusOptions={['pending', 'approved', 'paid', 'cancelled']}
      searchFields={(c) => [c.period, c.status]}
      emptyTitle="No commissions yet"
      emptyHint="Commissions are created automatically when a reseller's customer pays."
    />
  )
}

// -- Expenses -----------------------------------------------------------------
export function ExpensesPage() {
  const { expenses, loading } = usePanel()
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0)
  const columns: Column<Expense>[] = [
    { key: 'date', header: 'Date', sort: (e) => e.date, cell: (e) => <When value={e.date} /> },
    { key: 'category', header: 'Category', sort: (e) => e.category, cell: (e) => <Badge value={e.category.toLowerCase()} /> },
    { key: 'supplier', header: 'Supplier', sort: (e) => e.supplier ?? '', cell: (e) => e.supplier ?? '--' },
    { key: 'amount', header: 'Amount', sort: (e) => Number(e.amount), cell: (e) => <Money value={e.amount} /> },
    { key: 'recurring', header: 'Recurring', cell: (e) => (e.is_recurring ? <span className="font-mono text-[10px]">{e.recurrence}</span> : <span className="text-slate-300">--</span>) },
    { key: 'description', header: 'Description', cell: (e) => <span className="text-slate-400">{e.description ?? '--'}</span> },
  ]
  return (
    <ResourcePage
      title="Expenses" icon={<Wallet className="w-5 h-5" />}
      rows={expenses} columns={columns} rowKey={(e) => e.id} loading={loading}
      searchFields={(e) => [e.category, e.supplier ?? '', e.description ?? '']}
      emptyTitle="No expenses recorded"
      summary={<StatTile label="Total expenses" value={kes(total)} icon={<Wallet className="w-5 h-5" />} tone="amber" />}
    />
  )
}

// -- Inventory ----------------------------------------------------------------
export function InventoryPage() {
  const { inventory, loading } = usePanel()
  const columns: Column<InventoryItem>[] = [
    { key: 'sku', header: 'SKU', sort: (i) => i.sku, cell: (i) => <span className="font-mono font-bold text-[11px]">{i.sku}</span> },
    { key: 'name', header: 'Item', sort: (i) => i.name, cell: (i) => i.name },
    { key: 'category', header: 'Category', sort: (i) => i.category, cell: (i) => <Badge value={i.category.toLowerCase()} /> },
    { key: 'qty', header: 'In stock', sort: (i) => Number(i.quantity), cell: (i) => (
      <span className={`font-mono font-bold ${i.quantity <= i.reorder_level ? 'text-rose-600' : ''}`}>{i.quantity}</span>
    ) },
    { key: 'reorder', header: 'Reorder at', sort: (i) => Number(i.reorder_level), cell: (i) => <span className="font-mono text-[10px]">{i.reorder_level}</span> },
    { key: 'cost', header: 'Unit cost', sort: (i) => Number(i.unit_cost), cell: (i) => <Money value={i.unit_cost} /> },
    { key: 'value', header: 'Stock value', sort: (i) => Number(i.quantity) * Number(i.unit_cost), cell: (i) => <Money value={Number(i.quantity) * Number(i.unit_cost)} /> },
  ]
  const low = inventory.filter((i) => i.quantity <= i.reorder_level).length
  return (
    <ResourcePage
      title="Inventory" icon={<Boxes className="w-5 h-5" />}
      rows={inventory} columns={columns} rowKey={(i) => i.id} loading={loading}
      searchFields={(i) => [i.sku, i.name, i.category]}
      emptyTitle="No inventory items"
      summary={low > 0 ? <StatTile label="Items at or below reorder level" value={low} icon={<Boxes className="w-5 h-5" />} tone="amber" /> : undefined}
    />
  )
}

// -- Reports ------------------------------------------------------------------
export function ReportsPage() {
  const { stats, loading } = usePanel()
  const { clients, invoices } = useTenant()
  const { payments, renewals, transactions, accounts } = usePanel()
  const { expenses, commissions, smsMessages, resellers, inventory } = usePanel()

  if (loading || !stats) return <Spinner label="Building reports..." />

  const revenue = payments.filter((p) => p.status === 'success').reduce((s, p) => s + Number(p.amount), 0)
  const spend = expenses.reduce((s, e) => s + Number(e.amount), 0)
  const commissionDue = commissions.filter((c) => ['pending', 'approved'].includes(c.status)).reduce((s, c) => s + Number(c.amount), 0)
  const stockValue = inventory.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0)

  const rows = [
    { label: 'Collected revenue', value: kes(revenue), hint: `${payments.length} payment records` },
    { label: 'Operating expenses', value: kes(spend), hint: `${expenses.length} expense records` },
    { label: 'Commissions due', value: kes(commissionDue), hint: `${commissions.length} commission records` },
    { label: 'Net position', value: kes(revenue - spend - commissionDue), hint: 'Revenue less expenses and commissions' },
    { label: 'Receivables outstanding', value: kes(stats.outstanding), hint: `${stats.invoices_overdue} overdue invoices` },
    { label: 'Inventory value', value: kes(stockValue), hint: `${inventory.length} tracked items` },
    { label: 'Customer base', value: String(stats.total_customers), hint: `${stats.new_customers_month} joined this month` },
    { label: 'Active accounts', value: String(stats.active_customers), hint: `${stats.expiring_soon} expiring soon` },
    { label: 'HotSpot accounts', value: String(stats.hotspot_accounts), hint: `${stats.hotspot_online} online now` },
    { label: 'PPPoE accounts', value: String(stats.pppoe_accounts), hint: `${accounts.filter((a) => a.status === 'active').length} active` },
    { label: 'Renewals this period', value: String(renewals.length), hint: `${transactions.length} ledger entries` },
    { label: 'SMS activity', value: String(smsMessages.length), hint: `${stats.sms_month} sent this month` },
    { label: 'Active resellers', value: String(resellers.filter((r) => r.status === 'active').length), hint: `${resellers.length} total` },
    { label: 'Invoices issued', value: String(invoices.length), hint: `${invoices.filter((i) => i.status === 'paid').length} paid` },
    { label: 'Total customers', value: String(clients.length), hint: `${stats.suspended_customers} suspended` },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Reports</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Every figure computed from this ISP's own records.
        </p>
      </div>
      <Card>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((r) => (
            <div key={r.label} className="rounded-xl border border-slate-200 dark:border-slate-800 p-4">
              <p className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider">{r.label}</p>
              <p className="text-lg font-black text-slate-900 dark:text-white font-mono mt-1">{r.value}</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{r.hint}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// -- Staff & roles ------------------------------------------------------------
export function StaffPage() {
  const { clientRows, loading } = { clientRows: [], loading: false }
  void clientRows; void loading
  const { user } = useAuth()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Team</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Staff accounts belong to this ISP only.
        </p>
      </div>
      <Card className="p-5">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          You are signed in as <strong>{user?.profile.full_name}</strong> with the role{' '}
          <strong>{user?.profile.role?.replace('_', ' ')}</strong>.
        </p>
        <p className="text-[11px] text-slate-400 mt-2">
          Managing staff accounts is a super-admin action from{' '}
          <span className="font-mono">ISPs &rarr; your ISP &rarr; Team</span>.
        </p>
      </Card>
    </div>
  )
}

export function RolesPage() {
  const { permissions } = usePanel()
  const { roles, loading } = useTenant() as unknown as { roles: Array<{ id: string; key: string; name: string; description: string | null; permissions: string[]; is_system: boolean }>; loading: boolean }
  const byCategory = permissions.reduce<Record<string, typeof permissions>>((acc, p) => {
    ;(acc[p.category] ??= []).push(p)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          Roles &amp; Permissions
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          {Object.keys(byCategory).length} permission groups � {permissions.length} permissions
        </p>
      </div>

      {loading && <Spinner label="Loading roles..." />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(roles ?? []).map((r) => (
          <Card key={r.id}>
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-black text-slate-900 dark:text-white">{r.name}</p>
                <span className="font-mono text-[10px] text-slate-400">{r.permissions.length} perms</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{r.description}</p>
            </div>
            <div className="px-5 py-3 flex flex-wrap gap-1">
              {r.permissions.slice(0, 12).map((p) => (
                <span key={p} className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                  {p}
                </span>
              ))}
              {r.permissions.length > 12 && (
                <span className="font-mono text-[9px] px-1.5 py-0.5 text-slate-400">
                  +{r.permissions.length - 12} more
                </span>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

// -- Settings -----------------------------------------------------------------
export function SettingsPage() {
  const { user } = useAuth()
  const isp = user?.isp
  if (!isp) return <EmptyState title="No ISP configured" />
  const rows: Array<[string, string]> = [
    ['ISP name', isp.name],
    ['Portal subdomain', `${isp.slug}.portal`],
    ['Primary contact', isp.contact_email],
    ['Phone', isp.contact_phone ?? '--'],
    ['Location', [isp.city, isp.county, isp.country].filter(Boolean).join(', ')],
    ['Address', isp.address ?? '--'],
    ['Plan tier', isp.plan],
    ['Currency', 'KES'],
    ['Timezone', 'Africa/Nairobi'],
  ]
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
          ISP Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Profile and branding for this tenant only.
        </p>
      </div>
      <Card>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl grid place-items-center text-white font-black text-sm"
            style={{ backgroundColor: isp.brand_color }}>
            {isp.name.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-black text-slate-900 dark:text-white">{isp.name}</p>
            <p className="text-[10px] text-slate-400 font-mono">{isp.slug}.portal</p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-4 text-xs">
              <span className="text-slate-400 shrink-0">{k}</span>
              <span className="font-bold text-slate-700 dark:text-slate-200 text-right break-all">{v}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Payment, SMS and integration credentials are managed from the Super Admin panel so
          secrets never reach the tenant browser. Contact your platform operator to change them.
        </p>
      </Card>
    </div>
  )
}
