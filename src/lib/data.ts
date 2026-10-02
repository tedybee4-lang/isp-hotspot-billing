/**
 * Unified data access layer.
 *
 * Every screen talks to this module. It routes to Supabase when the project is
 * configured (enforced by Postgres RLS), or to the localStorage demo store
 * otherwise. Callers never branch on the mode themselves.
 */
import { IS_LIVE, config } from './config'
import { requireSupabase, functionsUrl } from './supabase'
import type {
  AuditLog, Client, Commission, DashboardStats, Expense, InventoryItem,
  InventoryMovement, Invoice, Isp, IspPlan, IspRole, IspStats, IspStatus,
  LedgerTransaction, Node, Payment, PermissionDefinition, Plan, Profile,
  Renewal, Reseller, ServiceAccount, Session as NetSession, SessionUser,
  SmsMessage, SmsTemplate, Ticket, TicketMessage, Voucher,
} from './types'
import * as demo from './demoStore'

const SESSION_KEY = 'ispflow.demo.session'

export class DataError extends Error {}

// ── Demo session ──────────────────────────────────────────────────────────────
function demoUser(): SessionUser | null {
  const id = localStorage.getItem(SESSION_KEY)
  if (!id) return null
  const db = demo.loadDb()
  const profile = db.profiles.find((p) => p.id === id)
  if (!profile) {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
  const isp = profile.isp_id ? db.isps.find((i) => i.id === profile.isp_id) ?? null : null
  const { password: _pw, email, ...rest } = profile
  void _pw
  return { id, email, profile: rest, isp }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<SessionUser> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (error) throw new DataError(error.message)
    return hydrate(data.user.id, data.user.email ?? email)
  }

  const db = demo.loadDb()
  const found = db.profiles.find(
    (p) => p.email.toLowerCase() === email.trim().toLowerCase() && p.password === password,
  )
  if (!found) throw new DataError('Invalid email or password.')
  if (!found.is_active) throw new DataError('This account has been deactivated.')

  localStorage.setItem(SESSION_KEY, found.id)
  const isp = found.isp_id ? db.isps.find((i) => i.id === found.isp_id) ?? null : null
  const { password: _pw, ...rest } = found
  void _pw
  return { id: found.id, email: found.email, profile: rest, isp }
}

/** Creates an auth user only — the tenant is created by `signupIsp`. */
export async function signUp(email: string, password: string, fullName: string) {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.auth.signUp({
      email, password, options: { data: { full_name: fullName } },
    })
    if (error) throw new DataError(error.message)
    if (!data.session) throw new DataError('Account created. Check your inbox to confirm, then sign in.')
    return
  }
  const db = demo.loadDb()
  if (db.profiles.some((p) => p.email.toLowerCase() === email.toLowerCase())) {
    throw new DataError('An account with that email already exists.')
  }
  db.profiles.push({
    id: demo.loadDb().profiles[0] ? `usr_${Math.random().toString(36).slice(2, 10)}` : 'usr_1',
    isp_id: null, role: 'client', full_name: fullName, phone: null,
    avatar_url: null, is_active: true, email, password,
  })
  demo.saveDb(db)
}

export async function signOut() {
  if (IS_LIVE) await requireSupabase().auth.signOut()
  localStorage.removeItem(SESSION_KEY)
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data } = await sb.auth.getSession()
    if (!data.session?.user) return null
    return hydrate(data.session.user.id, data.session.user.email ?? '')
  }
  return demoUser()
}

export function onAuthChange(cb: (user: SessionUser | null) => void) {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data } = sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session?.user) return cb(null)
      try {
        cb(await hydrate(session.user.id, session.user.email ?? ''))
      } catch {
        cb(null)
      }
    })
    return () => data.subscription.unsubscribe()
  }
  // Demo mode has no cross-tab session events; the caller re-reads on mount.
  return () => {}
}

async function hydrate(userId: string, email: string): Promise<SessionUser> {
  const sb = requireSupabase()
  const { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  if (error || !profile) throw new DataError('No profile found for this account.')

  let isp: Isp | null = null
  if (profile.isp_id) {
    const { data } = await sb.from('isps').select('*').eq('id', profile.isp_id).single()
    isp = data ?? null
  }
  return { id: userId, email, profile: profile as Profile, isp }
}

// ── Tenant provisioning ───────────────────────────────────────────────────────

export async function signupIsp(input: {
  name: string; slug: string; phone: string; county: string
  city: string; address: string; brandColor: string
}): Promise<string> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('signup_isp', {
      p_name: input.name, p_slug: input.slug, p_phone: input.phone,
      p_country: 'KE', p_county: input.county, p_city: input.city,
      p_address: input.address, p_brand_color: input.brandColor,
    })
    if (error) throw new DataError(error.message)
    return data as string
  }

  const user = demoUser()
  if (!user) throw new DataError('You must be signed in to register an ISP.')
  if (user.isp) throw new DataError('You already belong to an ISP on this platform.')

  const created = demo.demoCreateIsp(actorOf(user), {
    name: input.name, slug: input.slug, phone: input.phone,
    county: input.county, city: input.city,
    plan: 'starter', maxClients: 100, maxPlans: 5, maxNodes: 3,
  })
  return created.id
}

// ── Platform (super admin) ────────────────────────────────────────────────────

function requireSuper(user: SessionUser | null) {
  if (!user) throw new DataError('Not signed in.')
  if (user.profile.role !== 'super_admin') throw new DataError('Super admin privileges required.')
  return user
}

/** The actor shape the demo store records in the audit trail. */
const actorOf = (u: SessionUser) => ({
  id: u.id, email: u.email, role: u.profile.role,
})

export async function fetchIspStats(): Promise<IspStats[]> {
  const user = requireSuper(await getSessionUser())

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('platform_isp_stats').select('*').order('created_at', { ascending: false })
    if (error) throw new DataError(error.message)
    return (data ?? []) as IspStats[]
  }
  return demo.demoIspStats(actorOf(user)) as unknown as IspStats[]
}

export async function createIsp(input: {
  name: string; slug: string; phone: string; county: string; city: string
  plan: IspPlan; maxClients: number; maxPlans: number; maxNodes: number
}): Promise<Isp> {
  const user = requireSuper(await getSessionUser())

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.from('isps').insert({
      name: input.name, slug: input.slug.toLowerCase(), status: 'trial', plan: input.plan,
      contact_email: `pending@${input.slug.toLowerCase()}.co.ke`, contact_phone: input.phone,
      county: input.county, city: input.city, country: 'KE',
      max_clients: input.maxClients, max_plans: input.maxPlans, max_nodes: input.maxNodes,
      trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString(),
    }).select().single()
    if (error) throw new DataError(error.message)
    return data as Isp
  }
  return demo.demoCreateIsp(actorOf(user), input)
}

export async function updateIsp(id: string, patch: Partial<Isp>): Promise<Isp> {
  const user = requireSuper(await getSessionUser())
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.from('isps').update(patch).eq('id', id).select().single()
    if (error) throw new DataError(error.message)
    return data as Isp
  }
  return demo.demoUpdateIsp(actorOf(user), id, patch)
}

export async function setIspStatus(id: string, status: IspStatus) {
  const user = requireSuper(await getSessionUser())
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { error } = await sb.rpc('set_isp_status', { p_isp_id: id, p_status: status })
    if (error) throw new DataError(error.message)
    return
  }
  demo.demoUpdateIsp(actorOf(user), id, {
    status,
    suspended_at: status === 'suspended' ? new Date().toISOString() : null,
    onboarded_at: status === 'active' ? new Date().toISOString() : undefined,
  })
}

export async function setIspPlan(id: string, plan: IspPlan, maxClients: number, maxPlans: number, maxNodes: number) {
  const user = requireSuper(await getSessionUser())
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { error } = await sb.rpc('set_isp_plan', {
      p_isp_id: id, p_plan: plan,
      p_max_clients: maxClients, p_max_plans: maxPlans, p_max_nodes: maxNodes,
    })
    if (error) throw new DataError(error.message)
    return
  }
  demo.demoUpdateIsp(actorOf(user), id, {
    plan, max_clients: maxClients, max_plans: maxPlans, max_nodes: maxNodes,
  })
}

export async function deleteIsp(id: string) {
  const user = requireSuper(await getSessionUser())
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { error } = await sb.rpc('delete_isp', { p_isp_id: id })
    if (error) throw new DataError(error.message)
    return
  }
  demo.demoDeleteIsp(actorOf(user), id)
}

export async function fetchAuditLogs(limit = 100): Promise<AuditLog[]> {
  requireSuper(await getSessionUser())
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('audit_logs').select('*').order('created_at', { ascending: false }).limit(limit)
    if (error) throw new DataError(error.message)
    return (data ?? []) as AuditLog[]
  }
  return demo.loadDb().auditLogs.slice(0, limit)
}

export async function fetchTenantStaff(ispId?: string): Promise<Profile[]> {
  const user = await getSessionUser()
  if (!user) throw new DataError('Not signed in.')
  const target = ispId ?? user.isp?.id
  if (!target) throw new DataError('No ISP in scope.')

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('profiles').select('*').eq('isp_id', target).order('created_at')
    if (error) throw new DataError(error.message)
    return (data ?? []) as Profile[]
  }
  return demo.loadDb().profiles
    .filter((p) => p.isp_id === target)
    .map(({ password: _pw, ...rest }) => rest as unknown as Profile)
}

export async function inviteStaff(input: {
  ispId: string; email: string; password: string
  fullName: string; role: Profile['role']
}) {
  const user = await getSessionUser()
  if (user?.profile.role !== 'super_admin') throw new DataError('Super admin privileges required.')

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data: sess } = await sb.auth.getSession()
    const res = await fetch(functionsUrl('admin-invite'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify(input),
    })
    const body = await res.json()
    if (!res.ok) throw new DataError(body.error ?? 'Could not invite user')
    return body
  }

  const db = demo.loadDb()
  const email = input.email.trim().toLowerCase()
  if (db.profiles.some((p) => p.email.toLowerCase() === email)) {
    throw new DataError('A user with that email already exists.')
  }
  db.profiles.push({
    id: `usr_${Math.random().toString(36).slice(2, 10)}`,
    isp_id: input.ispId, role: input.role, full_name: input.fullName,
    phone: null, avatar_url: null, is_active: true,
    email, password: input.password,
  })
  demo.saveDb(db)
  demo.audit('staff:invited', actorOf(user), user.isp, 'profile', email, { email, role: input.role })
  return { success: true }
}

export type PaymentMode = 'manual_till' | 'platform_daraja' | 'own_daraja'

export interface PaymentModeInfo {
  value: PaymentMode
  label: string
  blurb: string
  needsKeys: boolean
}

/** The three supported ways an ISP can collect money. */
export const PAYMENT_MODES: PaymentModeInfo[] = [
  {
    value: 'manual_till',
    label: 'Manual Till / Paybill',
    blurb: 'No Safaricom API needed. The customer pays your Till number in the M-Pesa app or *334#, then you confirm it. Works for every ISP.',
    needsKeys: false,
  },
  {
    value: 'platform_daraja',
    label: 'Platform Daraja (shared)',
    blurb: 'The operator owns one Daraja app. Each ISP just adds their Till/Paybill shortcode — no API keys per ISP.',
    needsKeys: false,
  },
  {
    value: 'own_daraja',
    label: 'Own Daraja account',
    blurb: 'This ISP supplies their own consumer key, secret and passkey for automated STK Push.',
    needsKeys: true,
  },
]

/** Shape of a tenant's M-Pesa configuration. Secrets never leave the server. */
export interface PaymentConfig {
  isp_id: string
  payment_mode: PaymentMode
  mpesa_env: 'sandbox' | 'production'
  mpesa_shortcode: string | null
  till_number: string | null
  paybill_number: string | null
  callback_url: string | null
  customer_notice: string | null
}

/** Never exposes the secret columns — only whether each one is set. */
export interface PaymentConfigStatus extends PaymentConfig {
  has_passkey: boolean
  has_consumer_key: boolean
  has_consumer_secret: boolean
  /** Whether the shared platform credentials are complete. */
  platform_ready: boolean
  /** True when this tenant can actually collect money in its chosen mode. */
  ready: boolean
}

/** Platform-wide shared Daraja status (super admin only). */
export interface PlatformPaymentStatus {
  mpesa_env: 'sandbox' | 'production'
  has_passkey: boolean
  has_consumer_key: boolean
  has_consumer_secret: boolean
  ready: boolean
}

/** What the customer sees on a manual Till payment instruction screen. */
export interface ManualPaymentInstructions {
  paymentId: string
  amount: number
  reference: string
  tillNumber: string | null
  paybillNumber: string | null
  ispName: string
  phone: string | null
  notice: string | null
  instructions: string[]
  message: string
}

// ── M-Pesa configuration (super admin only) ───────────────────────────────────

/**
 * Reads a tenant's Daraja configuration.
 *
 * ⚠️  Selects only the non-secret columns plus boolean flags. The raw
 *     passkey / consumer key / secret are never returned to the browser —
 *     only the stk-push Edge Function (service role) can read them.
 */
const EMPTY_CONFIG = (ispId: string): PaymentConfigStatus => ({
  isp_id: ispId,
  payment_mode: 'manual_till',
  mpesa_env: 'sandbox',
  mpesa_shortcode: null, till_number: null, paybill_number: null,
  callback_url: null, customer_notice: null,
  has_passkey: false, has_consumer_key: false, has_consumer_secret: false,
  platform_ready: false, ready: false,
})

export async function fetchPaymentConfig(ispId: string): Promise<PaymentConfigStatus> {
  const user = await getSessionUser()
  if (user?.profile.role !== 'super_admin') {
    throw new DataError('Super admin privileges required.')
  }

  if (IS_LIVE) {
    const sb = requireSupabase()
    // A SECURITY DEFINER RPC so the raw secrets are never serialised out.
    const { data, error } = await sb.rpc('payment_config_status', { p_isp_id: ispId })
    if (error) throw new DataError(error.message)
    const row = data?.[0] as Partial<PaymentConfigStatus> | undefined
    if (!row) return EMPTY_CONFIG(ispId)
    return {
      ...EMPTY_CONFIG(ispId),
      ...row,
      isp_id: ispId,
      payment_mode: (row.payment_mode as PaymentMode) ?? 'manual_till',
    }
  }

  // Demo mode: a plausible, clearly-fake Till configuration.
  return {
    ...EMPTY_CONFIG(ispId),
    payment_mode: 'manual_till',
    till_number: '522533',
    paybill_number: '174379',
    customer_notice: 'Pay the exact amount so your account is credited automatically.',
  }
}

/**
 * Writes a tenant's Daraja configuration.
 *
 * Blank secret fields are left untouched so the UI never has to round-trip a
 * value it cannot read back.
 */
export async function updatePaymentConfig(
  ispId: string,
  patch: {
    payment_mode?: PaymentMode
    mpesa_env?: 'sandbox' | 'production'
    mpesa_shortcode?: string
    till_number?: string
    paybill_number?: string
    callback_url?: string
    customer_notice?: string
    mpesa_passkey?: string
    mpesa_consumer_key?: string
    mpesa_consumer_secret?: string
  },
) {
  const user = await getSessionUser()
  if (user?.profile.role !== 'super_admin') {
    throw new DataError('Super admin privileges required.')
  }

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { error } = await sb.rpc('set_payment_config', {
      p_isp_id: ispId,
      p_payment_mode: patch.payment_mode ?? null,
      p_mpesa_env: patch.mpesa_env ?? null,
      p_shortcode: patch.mpesa_shortcode ?? null,
      p_till_number: patch.till_number ?? null,
      p_paybill_number: patch.paybill_number ?? null,
      p_callback_url: patch.callback_url ?? null,
      p_customer_notice: patch.customer_notice ?? null,
      p_passkey: patch.mpesa_passkey ?? null,
      p_consumer_key: patch.mpesa_consumer_key ?? null,
      p_consumer_secret: patch.mpesa_consumer_secret ?? null,
    })
    if (error) throw new DataError(error.message)
    return
  }

  demo.audit('payment:configured', actorOf(user), null, 'payment_config', ispId, {
    mode: patch.payment_mode ?? 'unchanged',
  })
}

// ── Shared platform Daraja credentials ────────────────────────────────────────
export async function fetchPlatformPaymentStatus(): Promise<PlatformPaymentStatus> {
  const user = await getSessionUser()
  if (user?.profile.role !== 'super_admin') {
    throw new DataError('Super admin privileges required.')
  }
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('platform_payment_status')
    if (error) throw new DataError(error.message)
    const row = data?.[0] as Partial<PlatformPaymentStatus> | undefined
    return {
      mpesa_env: row?.mpesa_env === 'production' ? 'production' : 'sandbox',
      has_passkey: Boolean(row?.has_passkey),
      has_consumer_key: Boolean(row?.has_consumer_key),
      has_consumer_secret: Boolean(row?.has_consumer_secret),
      ready: Boolean(row?.ready),
    }
  }
  return {
    mpesa_env: 'sandbox',
    has_passkey: false, has_consumer_key: false, has_consumer_secret: false, ready: false,
  }
}

export async function updatePlatformPaymentConfig(patch: {
  mpesa_env?: 'sandbox' | 'production'
  mpesa_passkey?: string
  mpesa_consumer_key?: string
  mpesa_consumer_secret?: string
}) {
  const user = await getSessionUser()
  if (user?.profile.role !== 'super_admin') {
    throw new DataError('Super admin privileges required.')
  }
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { error } = await sb.rpc('set_platform_payment_config', {
      p_mpesa_env: patch.mpesa_env ?? null,
      p_passkey: patch.mpesa_passkey ?? null,
      p_consumer_key: patch.mpesa_consumer_key ?? null,
      p_consumer_secret: patch.mpesa_consumer_secret ?? null,
    })
    if (error) throw new DataError(error.message)
    return
  }
  demo.audit('mpesa:platform-configured', actorOf(user), null, 'platform_payment_config', undefined, {
    env: patch.mpesa_env ?? 'unchanged',
  })
}

// ── Domain accessors ──────────────────────────────────────────────────────────
// Every one of these goes through PostgREST. No isp_id filter is ever sent
// from the browser: RLS scopes each query to the caller's own tenant, so a
// spoofed tenant id simply matches nothing.

/** Real dashboard metrics, computed in SQL. No hardcoded numbers anywhere. */
export async function fetchDashboardStats(): Promise<DashboardStats | null> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('isp_dashboard_stats').select('*').limit(1).maybeSingle()
    if (error) throw new DataError(error.message)
    return (data as DashboardStats | null) ?? null
  }
  // Demo store computes the same numbers from the seeded rows.
  const user = await getSessionUser()
  const id = user?.isp?.id
  if (!id) return null
  const db = demo.loadDb()
  const since = (n: number) => Date.now() - n * 864e5
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const paid = (p: Payment) => p.isp_id === id && p.status === 'success'
  const sum = (rows: Payment[]) => rows.reduce((s, p) => s + Number(p.amount), 0)
  const clients = db.clients.filter((c) => c.isp_id === id)
  const invoices = db.invoices.filter((v) => v.isp_id === id)
  const nodes = db.nodes.filter((n) => n.isp_id === id)
  const now = Date.now()
  const STALE = 5 * 60 * 1000

  return {
    isp_id: id,
    total_customers: clients.length,
    active_customers: clients.filter((c) => c.status === 'active').length,
    expired_customers: clients.filter((c) => c.status === 'expired').length,
    suspended_customers: clients.filter((c) => c.status === 'suspended').length,
    pending_customers: clients.filter((c) => c.status === 'pending').length,
    expiring_soon: clients.filter((c) => c.status === 'active' && c.expires_at
      && new Date(c.expires_at).getTime() > now
      && new Date(c.expires_at).getTime() < now + 7 * 864e5).length,
    new_customers_month: clients.filter((c) => new Date(c.created_at).getTime() >= monthStart).length,
    hotspot_accounts: clients.filter((c) => (c.plan_name ?? '').toLowerCase().includes('hotspot')).length,
    pppoe_accounts: clients.filter((c) => (c.plan_name ?? '').toLowerCase().includes('pppoe')).length,
    online_now: db.sessions.filter((s) => s.isp_id === id && !s.ended_at).length,
    hotspot_online: db.sessions.filter((s) => s.isp_id === id && !s.ended_at && !!s.mac_address).length,
    routers_total: nodes.length,
    routers_online: nodes.filter((n) => n.status === 'online').length,
    routers_offline: nodes.filter((n) => n.status === 'offline').length,
    routers_stale: nodes.filter((n) => n.status !== 'offline'
      && (!n.last_seen || now - new Date(n.last_seen).getTime() > STALE)).length,
    revenue_today: sum(db.payments.filter((p) => paid(p) && new Date(p.created_at).getTime() >= now - 864e5)),
    revenue_month: sum(db.payments.filter((p) => paid(p) && new Date(p.created_at).getTime() >= monthStart)),
    revenue_30d: sum(db.payments.filter((p) => paid(p) && new Date(p.created_at).getTime() >= since(30))),
    payments_pending: db.payments.filter((p) => p.isp_id === id && p.status === 'pending').length,
    payments_failed: db.payments.filter((p) => p.isp_id === id && p.status === 'failed').length,
    payments_reversed: db.payments.filter((p) => p.isp_id === id && p.status === 'reversed').length,
    outstanding: invoices.filter((v) => ['unpaid', 'overdue'].includes(v.status))
      .reduce((s, v) => s + Number(v.amount), 0),
    invoices_overdue: invoices.filter((v) => v.status === 'overdue').length,
    vouchers_total: db.vouchers.filter((v) => v.isp_id === id).length,
    vouchers_unused: db.vouchers.filter((v) => v.isp_id === id && v.status === 'unused').length,
    vouchers_expired: db.vouchers.filter((v) => v.isp_id === id && v.status === 'expired').length,
    packages_active: db.plans.filter((p) => p.isp_id === id && p.is_active).length,
    expenses_month: db.expenses.filter((e) => e.isp_id === id
      && new Date(e.date).getTime() >= monthStart).reduce((s, e) => s + Number(e.amount), 0),
    resellers_active: db.resellers.filter((r) => r.isp_id === id && r.status === 'active').length,
    commissions_due: db.commissions.filter((c) => c.isp_id === id
      && ['pending', 'approved'].includes(c.status)).reduce((s, c) => s + Number(c.amount), 0),
    sms_month: db.smsMessages.filter((m) => m.isp_id === id
      && new Date(m.created_at).getTime() >= monthStart).length,
    inventory_low: db.inventoryItems.filter((i) => i.isp_id === id && i.quantity <= i.reorder_level).length,
    tickets_open: db.tickets.filter((t) => t.isp_id === id
      && ['open', 'in_progress'].includes(t.status)).length,
    staff_count: db.profiles.filter((p) => p.isp_id === id && p.is_active).length,
  }
}

/**
 * Generic tenant-table reader.
 *
 * `filters` are non-tenant predicates only (status, type, date). There is
 * deliberately no isp_id parameter: the tenant comes from the session.
 */
async function domain<T>(
  table: string,
  order: { column: string; ascending: boolean },
  fallback: (ispId: string) => T[],
  filters?: Record<string, unknown>,
): Promise<T[]> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    let q = sb.from(table).select('*')
    for (const [k, v] of Object.entries(filters ?? {})) {
      if (v !== undefined && v !== null && v !== 'all') q = q.eq(k, v)
    }
    const { data, error } = await q.order(order.column, { ascending: order.ascending })
    if (error) throw new DataError(error.message)
    return (data ?? []) as T[]
  }
  const id = demoUserSessionId() ?? ''
  let rows = fallback(id)
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (v !== undefined && v !== null && v !== 'all') {
      rows = rows.filter((r) => (r as Record<string, unknown>)[k] === v)
    }
  }
  return rows
}

export const fetchServiceAccounts = (type?: string) =>
  domain<ServiceAccount>('service_accounts', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().serviceAccounts.filter((s) => s.isp_id === id),
    type ? { service_type: type } : undefined)

export const fetchRenewals = () =>
  domain<Renewal>('renewals', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().renewals.filter((r) => r.isp_id === id))

export const fetchTransactions = () =>
  domain<LedgerTransaction>('transactions', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().transactions.filter((t) => t.isp_id === id))

export const fetchSmsTemplates = () =>
  domain<SmsTemplate>('sms_templates', { column: 'key', ascending: true },
    (id) => demo.loadDb().smsTemplates.filter((t) => t.isp_id === id))

export const fetchSmsMessages = () =>
  domain<SmsMessage>('sms_messages', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().smsMessages.filter((m) => m.isp_id === id))

export const fetchResellers = () =>
  domain<Reseller>('resellers', { column: 'full_name', ascending: true },
    (id) => demo.loadDb().resellers.filter((r) => r.isp_id === id))

export const fetchCommissions = () =>
  domain<Commission>('commissions', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().commissions.filter((c) => c.isp_id === id))

export const fetchExpenses = () =>
  domain<Expense>('expenses', { column: 'date', ascending: false },
    (id) => demo.loadDb().expenses.filter((e) => e.isp_id === id))

export const fetchInventoryItems = () =>
  domain<InventoryItem>('inventory_items', { column: 'name', ascending: true },
    (id) => demo.loadDb().inventoryItems.filter((i) => i.isp_id === id))

export const fetchInventoryMovements = () =>
  domain<InventoryMovement>('inventory_movements', { column: 'created_at', ascending: false },
    (id) => demo.loadDb().inventoryMovements.filter((m) => m.isp_id === id))

export const fetchIspRoles = () =>
  domain<IspRole>('isp_roles', { column: 'name', ascending: true },
    (id) => demo.loadDb().roles.filter((r) => r.isp_id === id))

export const fetchPermissions = async (): Promise<PermissionDefinition[]> => {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data } = await sb.from('permission_definitions').select('*').order('category')
    return (data ?? []) as PermissionDefinition[]
  }
  return demo.loadDb().permissionDefinitions
}

// ── Manual Till / Paybill collection (no API keys) ────────────────────────────

// __SPLIT__
// __SPLIT__

/** Creates a pending payment and returns what the customer must do to pay. */
export async function startManualPayment(
  invoiceId: string, phone?: string,
): Promise<ManualPaymentInstructions> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('start_manual_payment', {
      p_invoice_id: invoiceId, p_phone: phone ?? null,
    })
    if (error) throw new DataError(error.message)
    return data as ManualPaymentInstructions
  }

  const db = demo.loadDb()
  const inv = db.invoices.find((i) => i.id === invoiceId)
  if (!inv) throw new DataError('Invoice not found.')
  if (inv.status === 'paid') throw new DataError('This invoice is already paid.')

  const isp = db.isps.find((i) => i.id === inv.isp_id)
  const payment: Payment = {
    id: `pay_${Math.random().toString(36).slice(2, 10)}`,
    isp_id: inv.isp_id, client_id: inv.client_id, invoice_id: inv.id,
    phone: phone ?? '', amount: Number(inv.amount), method: 'till_manual',
    status: 'pending', checkout_request_id: null, mpesa_receipt: null,
    created_at: new Date().toISOString(),
  }
  db.payments.unshift(payment)
  demo.saveDb(db)

  return {
    paymentId: payment.id,
    amount: Number(inv.amount),
    reference: `${(isp?.slug ?? 'isp').slice(0, 3).toUpperCase()}-${inv.invoice_no.replace(/\D/g, '').slice(-6)}`,
    tillNumber: '522533',
    paybillNumber: '174379',
    ispName: isp?.name ?? 'This ISP',
    phone: phone ?? null,
    notice: 'Pay the exact amount so your account is credited automatically.',
    instructions: [
      'Open M-Pesa → Send Money → To Till Number',
      'Enter the Till number and the exact amount',
      'Use the reference above as the account name',
      'Then tap "I have paid" so we can verify',
    ],
    message: 'Payment instructions issued. Waiting for confirmation.',
  }
}

/** Staff confirms the money arrived; settles the invoice like a callback would. */
export async function confirmManualPayment(paymentId: string, receipt?: string) {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('confirm_manual_payment', {
      p_payment_id: paymentId, p_receipt: receipt ?? null,
    })
    if (error) throw new DataError(error.message)
    return data as { success: boolean; message: string }
  }

  const db = demo.loadDb()
  const pay = db.payments.find((p) => p.id === paymentId)
  if (!pay) throw new DataError('Payment not found.')
  if (pay.status !== 'pending') throw new DataError(`This payment is already ${pay.status}.`)

  pay.status = 'success'
  pay.mpesa_receipt = receipt ?? pay.mpesa_receipt

  if (pay.invoice_id) {
    const inv = db.invoices.find((i) => i.id === pay.invoice_id)
    if (inv) {
      inv.status = 'paid'
      inv.paid_at = new Date().toISOString()
      const c = inv.client_id ? db.clients.find((x) => x.id === inv.client_id) : null
      if (c) {
        c.status = 'active'
        c.balance = 0
        c.plan_name = inv.plan_name
        c.expires_at = new Date(Date.now() + 30 * 864e5).toISOString()
      }
    }
  }
  demo.saveDb(db)
  return { success: true, message: 'Payment confirmed and the invoice has been marked paid.' }
}

/** Payments still awaiting confirmation, for the ISP's billing screen. */
export async function fetchPendingPayments(): Promise<Payment[]> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('payments').select('*').eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) throw new DataError(error.message)
    return (data ?? []) as Payment[]
  }
  const id = demoUser()?.isp?.id
  if (!id) return []
  return demo.loadDb().payments.filter((p) => p.isp_id === id && p.status === 'pending')
}

// ── Tenant data ───────────────────────────────────────────────────────────────

/**
 * Reads one tenant table. `pick` extracts the current tenant's rows from the
 * demo store; live mode relies on RLS and just returns what Postgres allowed.
 */
async function tenantTable<T>(
  table: string,
  order: { column: string; ascending: boolean },
  pick: (ispId: string) => T[],
): Promise<T[]> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from(table).select('*').order(order.column, { ascending: order.ascending })
    if (error) throw new DataError(error.message)
    return (data ?? []) as T[]
  }
  return pick(demoUserSessionId() ?? '')
}

// Synchronous read of the demo session's tenant id (the demo store is synchronous)
function demoUserSessionId(): string | null {
  const id = localStorage.getItem(SESSION_KEY)
  if (!id) return null
  const profile = demo.loadDb().profiles.find((p) => p.id === id)
  return profile?.isp_id ?? null
}

export const fetchPlans = (): Promise<Plan[]> =>
  tenantTable('plans', { column: 'price', ascending: true },
    (ispId) => demo.loadDb().plans.filter((p) => p.isp_id === ispId).sort((a, b) => a.price - b.price))

export const fetchVouchers = (): Promise<Voucher[]> =>
  tenantTable('vouchers', { column: 'created_at', ascending: false },
    (ispId) => demo.loadDb().vouchers.filter((v) => v.isp_id === ispId))

export const fetchClients = (): Promise<Client[]> =>
  tenantTable('clients', { column: 'created_at', ascending: false },
    (ispId) => demo.loadDb().clients.filter((c) => c.isp_id === ispId))

export const fetchInvoices = (): Promise<Invoice[]> =>
  tenantTable('invoices', { column: 'due_date', ascending: false },
    (ispId) => demo.loadDb().invoices.filter((v) => v.isp_id === ispId))

export const fetchPayments = (): Promise<Payment[]> =>
  tenantTable('payments', { column: 'created_at', ascending: false },
    (ispId) => demo.loadDb().payments.filter((p) => p.isp_id === ispId))

export const fetchNodes = (): Promise<Node[]> =>
  tenantTable('nodes', { column: 'created_at', ascending: true },
    (ispId) => demo.loadDb().nodes.filter((n) => n.isp_id === ispId))

export const fetchSessions = (): Promise<NetSession[]> =>
  tenantTable('sessions', { column: 'started_at', ascending: false },
    (ispId) => demo.loadDb().sessions.filter((s) => s.isp_id === ispId))

export const fetchTickets = (): Promise<Ticket[]> =>
  tenantTable('tickets', { column: 'created_at', ascending: false },
    (ispId) => demo.loadDb().tickets.filter((t) => t.isp_id === ispId))

export async function fetchTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb
      .from('ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at')
    if (error) throw new DataError(error.message)
    return (data ?? []) as TicketMessage[]
  }
  return demo.loadDb().ticketMessages.filter((m) => m.ticket_id === ticketId)
}

// ── Tenant mutations ──────────────────────────────────────────────────────────

async function tenantId(): Promise<string> {
  const user = await getSessionUser()
  if (!user) throw new DataError('Not signed in.')
  if (!user.isp) throw new DataError('Your account is not attached to an ISP yet.')
  return user.isp.id
}

/**
 * Runs a write against Supabase, or the demo store. The live callback receives
 * the client plus the tenant id and must resolve `{ error }`.
 */
async function tenantWrite<T>(
  live: (sb: ReturnType<typeof requireSupabase>, ispId: string) => Promise<{ error: { message: string } | null }>,
  fallback: (ispId: string) => T,
): Promise<T | void> {
  const ispId = await tenantId()
  if (IS_LIVE) {
    const { error } = await live(requireSupabase(), ispId)
    if (error) throw new DataError(error.message)
    return undefined
  }
  return fallback(ispId)
}

export async function generateVouchers(planId: string, prefix: string, count: number): Promise<Voucher[]> {
  const ispId = await tenantId()
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('generate_vouchers', {
      p_isp_id: ispId, p_plan_id: planId, p_prefix: prefix, p_count: count,
    })
    if (error) throw new DataError(error.message)
    return (data ?? []) as Voucher[]
  }
  return demo.demoGenerateVouchers(ispId, planId, prefix, count)
}

export async function redeemVoucher(code: string) {
  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data, error } = await sb.rpc('redeem_voucher', { p_code: code })
    if (error) throw new DataError(error.message)
    return data as { success: boolean; message: string }
  }
  return demo.demoRedeemVoucher(code)
}

export const setNodeStatus = (nodeId: string, status: Node['status']) =>
  tenantWrite<void>(
    async (sb) => sb.from('nodes').update({ status }).eq('id', nodeId),
    () => { demo.demoSetNodeStatus(nodeId, status) },
  )

export const clearExpiredVouchers = () =>
  tenantWrite<void>(
    async (sb, ispId) => sb.from('vouchers').delete().eq('isp_id', ispId).eq('status', 'expired'),
    (ispId) => { demo.demoClearExpiredVouchers(ispId) },
  )

export const addTicket = (
  subject: string, category: string,
  priority: Ticket['priority'], clientId: string | null = null,
) =>
  tenantWrite<void>(
    async (sb, ispId) => sb.from('tickets').insert({
      isp_id: ispId, subject, category, priority, client_id: clientId,
    }),
    (ispId) => { demo.demoAddTicket(ispId, subject, category, priority, clientId) },
  )

export const addClient = (input: {
  full_name: string; phone: string; email: string; plan_name: string
}) =>
  tenantWrite<void>(
    async (sb, ispId) => sb.from('clients').insert({ ...input, isp_id: ispId }),
    (ispId) => { demo.demoAddClient(ispId, input) },
  )

export const setClientStatus = (clientId: string, status: Client['status']) =>
  tenantWrite<void>(
    async (sb) => sb.from('clients').update({ status }).eq('id', clientId),
    () => { demo.demoSetClientStatus(clientId, status) },
  )

export const kickSession = (sessionId: string) =>
  tenantWrite<void>(
    async (sb) => sb.from('sessions')
      .update({ ended_at: new Date().toISOString() }).eq('id', sessionId),
    () => { demo.demoKickSession(sessionId) },
  )

export const upgradePlan = (clientId: string, planName: string) =>
  tenantWrite<void>(
    async (sb) => sb.from('clients').update({ plan_name: planName }).eq('id', clientId),
    () => { demo.demoUpgradePlan(clientId, planName) },
  )

// ── Payments ──────────────────────────────────────────────────────────────────

/**
 * Starts an M-Pesa STK push. In live mode this calls the `stk-push` Edge
 * Function, which holds the Daraja secrets server-side. Demo mode settles the
 * invoice immediately so the whole flow stays testable offline.
 */
export async function initiateStkPush(input: {
  phone: string; amount: number; invoiceId?: string; clientId?: string
}): Promise<{ success: boolean; message: string; checkoutRequestId?: string }> {
  const ispId = await tenantId()

  if (IS_LIVE) {
    const sb = requireSupabase()
    const { data: sess } = await sb.auth.getSession()
    const res = await fetch(functionsUrl('stk-push'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ ...input, ispId }),
    })
    const body = await res.json()
    if (!res.ok) throw new DataError(body.error ?? 'Could not start the payment')
    return body
  }

  if (input.invoiceId) {
    demo.demoPayInvoice(input.invoiceId, input.phone)
    return {
      success: true,
      message: 'Payment received (demo). The invoice is now marked paid.',
    }
  }
  throw new DataError('Select an invoice before paying.')
}