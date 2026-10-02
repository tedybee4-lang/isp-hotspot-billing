/**
 * Adapters between the typed platform models (`src/lib/types.ts`) and the
 * view shapes the existing UI components expect (`src/data/mockData.ts`).
 *
 * This lets the original dashboard/portal/billing components keep working
 * unchanged while their data now comes from Postgres (or the demo store).
 */
import type {
  Client as PClient, Invoice as PInvoice, Node as PNode, Plan as PPlan,
  Session as PSession, Ticket as PTicket, TicketMessage, Voucher as PVoucher,
} from './types'
import type {
  ActiveSession, ClientProfile, Invoice as UIInvoice,
  NetworkNode, SupportTicket, Voucher as UIVoucher, HotspotPlan,
} from '../data/mockData'

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')

export const toPlan = (p: PPlan): HotspotPlan => ({
  id: p.id,
  name: p.name,
  duration: p.duration_label,
  durationHours: p.duration_hours,
  price: Number(p.price),
  speedLimit: p.speed_down,
  uploadLimit: p.speed_up,
  sharedUsers: p.shared_users,
  dataLimit: p.data_limit,
  popular: p.is_popular,
  type: p.kind === 'fiber' ? 'fiber' : 'hotspot',
})

const VOUCHER_STATUS: Record<PVoucher['status'], UIVoucher['status']> = {
  unused: 'Unused',
  active: 'Active',
  expired: 'Expired',
  disabled: 'Expired',
}

export function toVoucher(v: PVoucher, plans: PPlan[]): UIVoucher {
  const plan = plans.find((p) => p.id === v.plan_id)
  return {
    code: v.code,
    planName: plan?.name ?? 'Custom',
    duration: plan?.duration_label ?? '—',
    speedLimit: plan?.speed_down ?? '1 Mbps',
    status: VOUCHER_STATUS[v.status],
    activatedAt: v.activated_at ? new Date(v.activated_at).toLocaleString() : undefined,
    expiresAt: v.expires_at ? new Date(v.expires_at).toLocaleString() : undefined,
    usedBy: v.activated_by ?? undefined,
  }
}

/** Renders an uptime/duration in the "04h 22m" form the UI shows. */
function fmtUptime(startIso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 60000))
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}h ${String(mins % 60).padStart(2, '0')}m`
}

export const toSession = (s: PSession, nodes: PNode[]): ActiveSession => ({
  id: s.id,
  macAddress: s.mac_address ?? '—',
  ipAddress: s.ip_address ?? '—',
  voucherCode: s.voucher_code ?? undefined,
  deviceType: s.device_type ?? 'Unknown device',
  downloadedMb: Number(s.downloaded_mb),
  uploadedMb: Number(s.uploaded_mb),
  uptime: fmtUptime(s.started_at),
  node: nodes.find((n) => n.id === s.node_id)?.name ?? 'Unknown node',
})

const NODE_STATUS: Record<PNode['status'], NetworkNode['status']> = {
  online: 'Online',
  maintenance: 'Maintenance',
  offline: 'Offline',
}

export const toNode = (n: PNode): NetworkNode => ({
  id: n.id,
  name: n.name,
  activeUsers: n.active_users,
  loadPercent: n.load_percent,
  status: NODE_STATUS[n.status],
  bandwidthCapacity: n.capacity ?? '1 Gbps',
})

const SUB_STATUS: Record<PClient['status'], ClientProfile['status']> = {
  active: 'Active',
  suspended: 'Suspended',
  expired: 'Expired',
  pending: 'Suspended',
}

export const toClientProfile = (c: PClient): ClientProfile => ({
  accountNo: c.account_no,
  name: c.full_name,
  phone: c.phone,
  email: c.email ?? '',
  currentPlan: c.plan_name ?? 'No plan',
  status: SUB_STATUS[c.status],
  balance: Number(c.balance),
  expiryDate: c.expires_at ? c.expires_at.slice(0, 10) : '—',
  bandwidth: c.bandwidth ?? '1 Mbps Symmetrical',
})

const INVOICE_STATUS: Record<PInvoice['status'], UIInvoice['status']> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  overdue: 'Overdue',
  cancelled: 'Unpaid',
}

export const toInvoice = (i: PInvoice): UIInvoice => ({
  id: i.invoice_no,
  billingMonth: i.period_label,
  amount: Number(i.amount),
  dueDate: i.due_date,
  status: INVOICE_STATUS[i.status],
  paidAt: i.paid_at ? new Date(i.paid_at).toLocaleDateString() : undefined,
  planName: i.plan_name ?? '—',
})

const TICKET_CATEGORIES = [
  'Speed Issue', 'Payment Failed', 'Router Offline', 'Voucher Code Error',
] as const
type TicketCategory = (typeof TICKET_CATEGORIES)[number]

const asCategory = (c: string): TicketCategory =>
  (TICKET_CATEGORIES as readonly string[]).includes(c) ? (c as TicketCategory) : 'Speed Issue'

export function toTicket(
  t: PTicket,
  messages: TicketMessage[],
): SupportTicket {
  return {
    id: t.id.slice(0, 8).toUpperCase(),
    subject: t.subject,
    category: asCategory(t.category),
    status: t.status === 'closed' ? 'Resolved' : titleCase(t.status) as SupportTicket['status'],
    date: new Date(t.created_at).toLocaleString(),
    priority: titleCase(t.priority) as SupportTicket['priority'],
    messages: messages.map((m) => ({
      sender: m.sender === 'staff' ? 'admin' : 'client',
      text: m.body,
      time: new Date(m.created_at).toLocaleTimeString(),
    })),
  }
}

export const toPlans = (list: PPlan[]) => list.filter((p) => p.is_active).map(toPlan)