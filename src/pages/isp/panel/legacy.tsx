/** Remaining panel sections that need bespoke column definitions. */
import { useTenant } from '../../../context/TenantContext'
import { usePanel } from '../../../context/PanelContext'
import { ResourcePage, Money, When, StatusCell, type Column } from '../../../components/ui/ResourcePage'
import NetworkStatus from '../../../components/NetworkStatus'
import { RoutersPage } from '../routers/RoutersPage'
import HotspotPortal from '../../../components/HotspotPortal'
import { toTicket, toVoucher } from '../../../lib/adapters'
import { Spinner } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useEffect, useState } from 'react'
import { fetchAuditLogs } from '../../../lib/data'
import type {
  AuditLog, LedgerTransaction, Node, Plan, Renewal, ServiceAccount,
} from '../../../lib/types'

// -- Tickets ------------------------------------------------------------------
export function TicketsRoute() {
  const { tickets, messagesFor, clients, loading } = useTenant()
  const rows = tickets.map((t) => toTicket(t, []))
  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'subject', header: 'Subject', sort: (t) => t.subject, cell: (t) => <span className="font-bold text-slate-800 dark:text-white">{t.subject}</span> },
    { key: 'category', header: 'Category', sort: (t) => t.category, cell: (t) => t.category },
    { key: 'priority', header: 'Priority', sort: (t) => t.priority, cell: (t) => <StatusCell value={t.priority} /> },
    { key: 'status', header: 'Status', sort: (t) => t.status, cell: (t) => <StatusCell value={t.status} /> },
    { key: 'date', header: 'Opened', sort: (t) => t.date, cell: (t) => <When value={t.date} /> },
  ]
  void messagesFor; void clients
  return (
    <ResourcePage
      title="Support Tickets" icon={<ShieldIcon />}
      rows={rows} columns={columns} rowKey={(t) => t.id} loading={loading}
      statusField="status" statusOptions={['Open', 'In Progress', 'Resolved']}
      searchFields={(t) => [t.subject, t.category]}
      emptyTitle="No support tickets"
    />
  )
}
const ShieldIcon = () => <span className="w-5 h-5" />

// -- Packages -----------------------------------------------------------------
export function PackagesRoute() {
  const { plans, loading } = useTenant()
  const columns: Column<Plan>[] = [
    { key: 'name', header: 'Package', sort: (p) => p.name, cell: (p) => <span className="font-bold text-slate-800 dark:text-white">{p.name}</span> },
    { key: 'kind', header: 'Type', sort: (p) => p.kind, cell: (p) => <StatusCell value={p.kind} /> },
    { key: 'duration', header: 'Duration', sort: (p) => p.duration_label, cell: (p) => p.duration_label },
    { key: 'price', header: 'Price', sort: (p) => Number(p.price), cell: (p) => <Money value={p.price} /> },
    { key: 'down', header: 'Download', sort: (p) => p.speed_down, cell: (p) => <span className="font-mono text-[10px]">{p.speed_down}</span> },
    { key: 'up', header: 'Upload', sort: (p) => p.speed_up, cell: (p) => <span className="font-mono text-[10px]">{p.speed_up}</span> },
    { key: 'users', header: 'Users', sort: (p) => Number(p.shared_users), cell: (p) => <span className="font-mono text-[10px]">{p.shared_users}</span> },
    { key: 'data', header: 'Data', cell: (p) => <span className="text-slate-400">{p.data_limit}</span> },
    { key: 'active', header: 'Status', cell: (p) => <StatusCell value={p.is_active ? 'active' : 'suspended'} /> },
  ]
  return (
    <ResourcePage
      title="Packages" subtitle={`${plans.length} packages for this ISP`}
      icon={<PackageIcon />} rows={plans} columns={columns} rowKey={(p) => p.id} loading={loading}
      searchFields={(p) => [p.name, p.kind, p.duration_label]}
      emptyTitle="No packages defined"
    />
  )
}
const PackageIcon = () => <span className="w-5 h-5" />

// -- HotSpot ------------------------------------------------------------------
export function HotspotRoute() {
  const { plans, vouchers, redeemVoucher, generateVouchers, loading } = useTenant()
  if (loading) return <Spinner label="Loading HotSpot..." />
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">HotSpot</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Voucher redemption and the customer-facing captive portal for this ISP.
        </p>
      </div>
      <HotspotPortal
        plans={plans.filter((p) => p.kind !== 'fiber').map((p) => ({
          id: p.id, name: p.name, duration: p.duration_label, durationHours: p.duration_hours,
          price: Number(p.price), speedLimit: p.speed_down, uploadLimit: p.speed_up,
          sharedUsers: p.shared_users, dataLimit: p.data_limit,
          popular: p.is_popular, type: 'hotspot' as const,
        }))}
        vouchers={vouchers.map((v) => toVoucher(v, plans))}
        isConnected={false}
        activeVoucherCode={null}
        onActivateVoucher={async (code) => {
          const res = await redeemVoucher(code)
          return res
        }}
        onDisconnect={() => {}}
        onPurchaseVoucher={(plan) => {
          const match = plans.find((p) => p.name === plan.name)
          if (match) void generateVouchers(match.id, 'HS', 1)
          return ''
        }}
      />
    </div>
  )
}

// -- PPPoE --------------------------------------------------------------------
export function PppoeRoute() {
  const { accounts, loading } = usePanel()
  const pppoe = accounts.filter((a) => a.service_type === 'pppoe')
  const columns: Column<ServiceAccount>[] = [
    { key: 'username', header: 'Username', sort: (a) => a.username, cell: (a) => <span className="font-mono font-bold text-[11px]">{a.username}</span> },
    { key: 'ip', header: 'IP', cell: (a) => <span className="font-mono text-[10px]">{a.ip_address ?? '--'}</span> },
    { key: 'radius', header: 'RADIUS id', cell: (a) => <span className="font-mono text-[10px] text-slate-400">{a.radius_user_id ?? '--'}</span> },
    { key: 'last', header: 'Last seen', sort: (a) => a.last_seen_at ?? '', cell: (a) => <When value={a.last_seen_at} /> },
    { key: 'expiry', header: 'Expires', sort: (a) => a.expires_at ?? '', cell: (a) => <When value={a.expires_at} /> },
    { key: 'status', header: 'Status', sort: (a) => a.status, cell: (a) => <StatusCell value={a.status} /> },
  ]
  return (
    <ResourcePage
      title="PPPoE" subtitle={`${pppoe.length} PPPoE accounts`}
      icon={<PlugIcon />} rows={pppoe} columns={columns} rowKey={(a) => a.id} loading={loading}
      statusField="status" statusOptions={['active', 'expired', 'suspended', 'pending']}
      searchFields={(a) => [a.username, a.ip_address ?? '', a.radius_user_id ?? '']}
      emptyTitle="No PPPoE accounts"
      emptyHint="Accounts appear when the ISP provisions service logins."
    />
  )
}
const PlugIcon = () => <span className="w-5 h-5" />

// -- Routers / Network status -------------------------------------------------
export function RoutersRoute() {
  const { nodes, loading } = useTenant()
  if (loading) return <Spinner label="Loading routers..." />
  return (
    <div className="space-y-6">
      <NetworkStatus nodes={nodes} />
      <RoutersPage />
      <NodeTable nodes={nodes} />
    </div>
  )
}

function NodeTable({ nodes }: { nodes: Node[] }) {
  const columns: Column<Node>[] = [
    { key: 'name', header: 'Router', sort: (n) => n.name, cell: (n) => <span className="font-bold text-slate-800 dark:text-white">{n.name}</span> },
    { key: 'model', header: 'Model', sort: (n) => n.model ?? '', cell: (n) => n.model ?? <span className="text-slate-300 italic">No data</span> },
    { key: 'host', header: 'Address', cell: (n) => <span className="font-mono text-[10px]">{n.host ?? '--'}</span> },
    { key: 'os', header: 'RouterOS', cell: (n) => <span className="font-mono text-[10px]">{n.os_version ?? '--'}</span> },
    { key: 'users', header: 'Users', sort: (n) => Number(n.active_users), cell: (n) => <span className="font-mono text-[10px]">{n.active_users}</span> },
    { key: 'cpu', header: 'CPU', sort: (n) => Number(n.cpu_load ?? -1), cell: (n) => n.cpu_load !== null ? <span className="font-mono text-[10px]">{n.cpu_load}%</span> : <span className="text-slate-300 italic text-[10px]">No data</span> },
    { key: 'status', header: 'Status', sort: (n) => n.status, cell: (n) => <StatusCell value={n.status} /> },
    { key: 'seen', header: 'Last heartbeat', sort: (n) => n.last_seen ?? '', cell: (n) => <When value={n.last_seen} /> },
  ]
  return (
    <ResourcePage
      title="Routers" subtitle="Routers registered to this ISP"
      icon={<PlugIcon />} rows={nodes} columns={columns} rowKey={(n) => n.id}
      searchFields={(n) => [n.name, n.model ?? '', n.host ?? '']}
      emptyTitle="No routers registered"
    />
  )
}

// -- Renewals & transactions --------------------------------------------------
export function RenewalsRoute() {
  const { renewals, loading } = usePanel()
  const columns: Column<Renewal>[] = [
    { key: 'date', header: 'Renewed', sort: (r) => r.created_at, cell: (r) => <When value={r.created_at} /> },
    { key: 'prev', header: 'Previous expiry', cell: (r) => <When value={r.previous_expiry} /> },
    { key: 'next', header: 'New expiry', sort: (r) => r.new_expiry, cell: (r) => <When value={r.new_expiry} /> },
    { key: 'amount', header: 'Amount', sort: (r) => Number(r.amount), cell: (r) => <Money value={r.amount} /> },
    { key: 'note', header: 'Note', cell: (r) => <span className="text-slate-400">{r.note ?? '--'}</span> },
  ]
  return (
    <ResourcePage
      title="Renewals" icon={<RefreshIcon />} rows={renewals} columns={columns}
      rowKey={(r) => r.id} loading={loading}
      searchFields={(r) => [r.note ?? '']}
      emptyTitle="No renewals recorded"
    />
  )
}
const RefreshIcon = () => <span className="w-5 h-5" />

export function TransactionsRoute() {
  const { transactions, loading } = usePanel()
  const columns: Column<LedgerTransaction>[] = [
    { key: 'date', header: 'Date', sort: (t) => t.created_at, cell: (t) => <When value={t.created_at} /> },
    { key: 'kind', header: 'Type', sort: (t) => t.kind, cell: (t) => <StatusCell value={t.kind} /> },
    { key: 'dir', header: 'Direction', sort: (t) => t.direction, cell: (t) => (
      <span className={`font-mono text-[10px] font-bold ${t.direction === 'credit' ? 'text-emerald-600' : 'text-rose-600'}`}>
        {t.direction.toUpperCase()}
      </span>
    ) },
    { key: 'amount', header: 'Amount', sort: (t) => Number(t.amount), cell: (t) => <Money value={t.amount} /> },
    { key: 'ref', header: 'Reference', cell: (t) => <span className="font-mono text-[10px] text-slate-400">{t.reference ?? '--'}</span> },
    { key: 'memo', header: 'Memo', cell: (t) => <span className="text-slate-400">{t.memo ?? '--'}</span> },
  ]
  return (
    <ResourcePage
      title="Transactions" subtitle="Ledger entries for this ISP"
      icon={<LedgerIcon />} rows={transactions} columns={columns} rowKey={(t) => t.id} loading={loading}
      statusField="kind" statusOptions={['payment', 'renewal', 'expense', 'commission', 'adjustment', 'refund']}
      searchFields={(t) => [t.reference ?? '', t.memo ?? '', t.kind]}
      emptyTitle="No transactions yet"
    />
  )
}

const LedgerIcon = () => <span className="w-5 h-5" />

// ── Roles (defined in the main panel module) ─────────────────────────────────
export { RolesPage as RolesRoute } from './index'

// ── Audit (tenant-scoped view of the platform log) ───────────────────────────
export function AuditRoute() {
  const { user } = useAuth()
  const [rows, setRows] = useState<AuditLog[]>([])

  useEffect(() => {
    fetchAuditLogs(200)
      .then((all) => setRows(all.filter(
        (l) => l.isp_id === user?.isp?.id || l.actor_id === user?.id,
      )))
      .catch(() => setRows([]))
  }, [user])

  const columns: Column<AuditLog>[] = [
    { key: 'when', header: 'When', sort: (l) => l.created_at, cell: (l) => <When value={l.created_at} /> },
    { key: 'actor', header: 'Actor', sort: (l) => l.actor_email ?? '', cell: (l) => (
      <span className="font-mono text-[10px]">{l.actor_email ?? 'system'}</span>
    ) },
    { key: 'action', header: 'Action', sort: (l) => l.action, cell: (l) => <StatusCell value={l.action.split(':')[0]} /> },
    { key: 'target', header: 'Target', cell: (l) => <span className="text-slate-400">{l.target_type ?? '--'}</span> },
  ]

  return (
    <ResourcePage
      title="Audit Log" subtitle="Actions recorded against this ISP"
      icon={<LedgerIcon />} rows={rows} columns={columns} rowKey={(l) => l.id}
      searchFields={(l) => [l.action, l.actor_email ?? '']}
      emptyTitle="No audit entries yet"
    />
  )
}
