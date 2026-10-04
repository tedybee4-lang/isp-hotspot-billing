/** Domain types shared by the whole app. Mirrors the Postgres schema. */

export type PlatformRole = 'super_admin' | 'isp_owner' | 'isp_admin' | 'isp_agent' | 'client'
export type IspStatus = 'trial' | 'active' | 'suspended' | 'churned'
export type IspPlan = 'starter' | 'growth' | 'enterprise'

export interface Profile {
  id: string
  isp_id: string | null
  role: PlatformRole
  full_name: string | null
  phone: string | null
  avatar_url: string | null
  is_active: boolean
}

export interface Isp {
  id: string
  name: string
  slug: string
  status: IspStatus
  plan: IspPlan
  contact_email: string
  contact_phone: string | null
  country: string
  county: string | null
  city: string | null
  address: string | null
  brand_color: string
  logo_url: string | null
  portal_domain: string | null
  max_clients: number
  max_plans: number
  max_nodes: number
  trial_ends_at: string | null
  onboarded_at: string | null
  suspended_at: string | null
  created_at: string
  updated_at: string
}

/** Row returned by the `platform_isp_stats` view (super admin only). */
export interface IspStats extends Isp {
  staff_count: number
  active_clients: number
  total_clients: number
  plan_count: number
  voucher_count: number
  nodes_online: number
  revenue_30d: number
  outstanding: number
  last_payment_at: string | null
}

export interface Plan {
  id: string
  isp_id: string
  name: string
  kind: 'hotspot' | 'fiber' | 'pppoe'
  duration_label: string
  duration_hours: number
  price: number
  speed_down: string
  speed_up: string
  shared_users: number
  data_limit: string
  is_popular: boolean
  is_active: boolean
  /** Speed after the quota is used up, e.g. "512 kbps". */
  fup?: string | null
  description?: string | null
  /** Whether this package appears on the ISP's captive portal. */
  show_on_portal?: boolean
  /** What happens when the package expires. */
  expiry_action?: 'disable' | 'remove' | 'notify'
  created_at?: string
  updated_at?: string
}

export interface Voucher {
  id: string
  isp_id: string
  plan_id: string | null
  code: string
  batch_prefix: string | null
  status: 'unused' | 'active' | 'expired' | 'disabled'
  activated_by: string | null
  activated_at: string | null
  expires_at: string | null
  created_at: string
}

export interface Client {
  id: string
  isp_id: string
  account_no: string
  full_name: string
  phone: string
  email: string | null
  plan_name: string | null
  reseller_id: string | null
  status: 'pending' | 'active' | 'suspended' | 'expired'
  balance: number
  bandwidth: string | null
  expires_at: string | null
  created_at: string
}

export interface Invoice {
  id: string
  isp_id: string
  client_id: string | null
  invoice_no: string
  period_label: string
  plan_name: string | null
  amount: number
  due_date: string
  status: 'unpaid' | 'paid' | 'overdue' | 'cancelled'
  paid_at: string | null
  created_at: string
}

export interface Payment {
  id: string
  isp_id: string
  client_id: string | null
  invoice_id: string | null
  phone: string | null
  amount: number
  method: string
  status: 'pending' | 'success' | 'failed' | 'reversed'
  checkout_request_id: string | null
  mpesa_receipt: string | null
  created_at: string
  /**
   * Which provider collected this payment: 'payhero', 'hashback', or 'manual'.
   *
   * Present on every payment and null for a manual Till collection, which has no
   * provider behind it. The ISP payment list shows it so an operator can tell an
   * automated payment from a hand-confirmed one without inferring it from `method`.
   */
  payment_provider?: string | null
  /** Our own opaque reference. The only thing a callback can be matched on. */
  provider_reference?: string | null
  /** The reference PayHero itself issued. Not an M-Pesa receipt. */
  provider_transaction_id?: string | null
  /** The M-Pesa receipt code, as a customer would quote it. */
  provider_receipt?: string | null
  /**
   * The PayHero channel that took this payment. An identifier PayHero reported,
   * never a credential, and null for every non-PayHero payment.
   */
  payhero_channel_id?: number | null
  /** Why a payment failed, when it did. Provider text, never an exception. */
  failure_reason?: string | null
  /** When the prompt was sent, as opposed to when the row was created. */
  initiated_at?: string | null
  /** When verified settlement completed. Null while the payment is unresolved. */
  settled_at?: string | null
  /** Package name recorded at purchase time, for the history list. */
  package_name?: string | null
}

export interface Node {
  id: string
  isp_id: string
  name: string
  host: string | null
  model: string | null
  os_version: string | null
  serial_number: string | null
  routeros_version: string | null
  status: 'online' | 'offline' | 'maintenance'
  active_users: number
  load_percent: number
  capacity: string | null
  cpu_load: number | null
  ram_used_mb: number | null
  ram_total_mb: number | null
  uptime_seconds: number | null
  notes: string | null
  last_seen: string | null
  /** RouterOS REST port. 8728 is the default; 8729 is often used instead. */
  api_port: number
  /** When false the poller skips this router. */
  enabled: boolean
  poll_interval_secs: number
  last_poll_at: string | null
  /** Why the last poll failed. Null when the last poll succeeded. */
  last_error: string | null
  last_latency_ms: number | null
}

export interface Session {
  id: string
  isp_id: string
  node_id: string | null
  voucher_code: string | null
  mac_address: string | null
  ip_address: string | null
  device_type: string | null
  downloaded_mb: number
  uploaded_mb: number
  started_at: string
  ended_at: string | null
  /**
   * RADIUS identity. The authoritative fields for a network session.
   *
   * The fields above predate FreeRADIUS and are what the older OAuth-era
   * `sessions` table carried. A live network session is recorded in
   * radius_sessions, which has no mac_address and does have a username, so
   * these are what the live-users panel should actually show. Optional because
   * the demo store still produces rows in the old shape.
   */
  username?: string | null
  acct_session_id?: string | null
  router_name?: string | null
  nas_identifier?: string | null
  duration_secs?: number | null
  end_reason?: string | null
  /** True only when RADIUS says the session has not ended. */
  is_active?: boolean
  /** False for a closed session, so the UI need not offer a pointless action. */
  can_disconnect?: boolean
}

export interface Ticket {
  id: string
  isp_id: string
  client_id: string | null
  subject: string
  category: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  created_at: string
  updated_at: string
}

export interface TicketMessage {
  id: string
  ticket_id: string
  sender: 'client' | 'staff' | 'system'
  body: string
  created_at: string
}

export interface AuditLog {
  id: string
  actor_id: string | null
  actor_email: string | null
  actor_role: PlatformRole | null
  isp_id: string | null
  isp_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

/** ── Domain models added for the full ISP panel ────────────────────────── */

/** A HotSpot / PPPoE login account (distinct from the billing customer). */
export interface ServiceAccount {
  id: string
  isp_id: string
  client_id: string | null
  username: string
  service_type: 'hotspot' | 'pppoe' | 'fiber'
  plan_id: string | null
  status: 'active' | 'expired' | 'suspended' | 'pending'
  ip_address: string | null
  mac_address: string | null
  router_id: string | null
  radius_user_id: string | null
  last_seen_at: string | null
  expires_at: string | null
  created_at: string
}

export interface Renewal {
  id: string
  isp_id: string
  client_id: string | null
  plan_id: string | null
  previous_expiry: string | null
  new_expiry: string
  amount: number
  payment_id: string | null
  note: string | null
  created_at: string
}

export interface LedgerTransaction {
  id: string
  isp_id: string
  client_id: string | null
  kind: 'payment' | 'renewal' | 'expense' | 'commission' | 'adjustment' | 'refund'
  direction: 'credit' | 'debit'
  amount: number
  reference: string | null
  memo: string | null
  created_at: string
}

export interface SmsTemplate {
  id: string
  isp_id: string
  key: string
  name: string
  body: string
  variables: string[]
  is_active: boolean
}

export interface SmsMessage {
  id: string
  isp_id: string
  client_id: string | null
  template_key: string | null
  to_number: string
  body: string
  status: 'queued' | 'sent' | 'delivered' | 'failed'
  provider: string | null
  provider_id: string | null
  error: string | null
  segments: number | null
  cost: number | null
  sent_at: string | null
  created_at: string
}

export interface Reseller {
  id: string
  isp_id: string
  user_id: string | null
  code: string
  full_name: string
  phone: string | null
  email: string | null
  commission_rate: number
  credit_limit: number
  balance: number
  status: 'active' | 'suspended'
  created_at: string
}

export interface Commission {
  id: string
  isp_id: string
  reseller_id: string
  payment_id: string | null
  sale_amount: number
  rate: number
  amount: number
  period: string
  status: 'pending' | 'approved' | 'paid' | 'cancelled'
  paid_at: string | null
  created_at: string
}

export interface Expense {
  id: string
  isp_id: string
  category: string
  amount: number
  date: string
  supplier: string | null
  description: string | null
  is_recurring: boolean
  recurrence: string | null
  recurring_until: string | null
  created_at: string
}

export interface InventoryItem {
  id: string
  isp_id: string
  sku: string
  name: string
  category: string
  unit: string
  quantity: number
  unit_cost: number
  reorder_level: number
  created_at: string
}

export interface InventoryMovement {
  id: string
  isp_id: string
  item_id: string
  kind: 'purchase' | 'issue' | 'assign' | 'return' | 'damage' | 'adjust'
  quantity: number
  client_id: string | null
  note: string | null
  created_at: string
}

export interface IspRole {
  id: string
  isp_id: string
  key: string
  name: string
  description: string | null
  permissions: string[]
  is_system: boolean
}

export interface PermissionDefinition {
  key: string
  label: string
  category: string
}

/** Every dashboard number. Computed in SQL, never hardcoded in the UI. */
export interface DashboardStats {
  isp_id: string
  total_customers: number
  active_customers: number
  expired_customers: number
  suspended_customers: number
  pending_customers: number
  expiring_soon: number
  new_customers_month: number
  hotspot_accounts: number
  pppoe_accounts: number
  online_now: number
  hotspot_online: number
  routers_total: number
  routers_online: number
  routers_offline: number
  routers_stale: number
  revenue_today: number
  revenue_month: number
  revenue_30d: number
  payments_pending: number
  payments_failed: number
  payments_reversed: number
  outstanding: number
  invoices_overdue: number
  vouchers_total: number
  vouchers_unused: number
  vouchers_expired: number
  packages_active: number
  expenses_month: number
  resellers_active: number
  commissions_due: number
  sms_month: number
  inventory_low: number
  tickets_open: number
  staff_count: number
}

/** Signed-in user as the app sees it. */
export interface SessionUser {
  id: string
  email: string
  profile: Profile
  isp: Isp | null
}

export const STAFF_ROLES: PlatformRole[] = ['isp_owner', 'isp_admin', 'isp_agent']

export const isStaff = (role: PlatformRole) => STAFF_ROLES.includes(role)
export const isSuperAdmin = (role: PlatformRole) => role === 'super_admin'
export const canManageIsp = (role: PlatformRole) => role === 'isp_owner' || role === 'isp_admin'