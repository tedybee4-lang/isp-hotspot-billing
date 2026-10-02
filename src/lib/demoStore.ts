/**
 * Demo backend — a localStorage-backed simulation of the whole platform.
 *
 * Used automatically when no Supabase project is configured, so the app is
 * fully clickable on localhost with zero setup. It mirrors the API surface of
 * the live repository (see `data.ts`), including per-tenant isolation, so
 * switching to Supabase changes nothing above this layer.
 *
 * ⚠️ Demo passwords are stored in plaintext in localStorage. That is fine for
 * local testing ONLY — never ship demo mode to production.
 */
import type {
  AuditLog, Client, Commission, Expense, InventoryItem, InventoryMovement,
  Isp, IspRole, Invoice, LedgerTransaction, Node, Payment,
  PermissionDefinition, Plan, Profile, Renewal, Reseller, ServiceAccount,
  Session, SmsMessage, SmsTemplate, Ticket, TicketMessage, Voucher,
} from './types'

const KEY = 'ispflow.demo.v1'
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString()
const daysAhead = (n: number) => new Date(Date.now() + n * 864e5).toISOString()
const pick = <T>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]

/** A demo user = a profile plus the plaintext credentials we compare against. */
export type DemoUser = Profile & { email: string; password: string }

export interface DemoDb {
  isps: Isp[]
  profiles: DemoUser[]
  plans: Plan[]
  vouchers: Voucher[]
  clients: Client[]
  invoices: Invoice[]
  payments: Payment[]
  nodes: Node[]
  sessions: Session[]
  tickets: Ticket[]
  ticketMessages: TicketMessage[]
  auditLogs: AuditLog[]
  // Domain tables (all tenant-scoped)
  serviceAccounts: ServiceAccount[]
  renewals: Renewal[]
  transactions: LedgerTransaction[]
  smsTemplates: SmsTemplate[]
  smsMessages: SmsMessage[]
  resellers: Reseller[]
  commissions: Commission[]
  expenses: Expense[]
  inventoryItems: InventoryItem[]
  inventoryMovements: InventoryMovement[]
  roles: IspRole[]
  permissionDefinitions: PermissionDefinition[]
}

interface SeedResult {
  isp: Isp
  owner: DemoUser
  plans: Plan[]
  clients: Client[]
  invoices: Invoice[]
  payments: Payment[]
  vouchers: Voucher[]
  nodes: Node[]
  sessions: Session[]
  tickets: Ticket[]
  ticketMessages: TicketMessage[]
}

// ── Seed fixtures ─────────────────────────────────────────────────────────────

type Cat = [string, Plan['kind'], string, number, number, string, string, number, boolean]

const CATALOGUE: Cat[] = [
  ['Hourly Hotspot',  'hotspot', '1 Hour',    1,    10,   '1 Mbps',  '2 Mbps',  1,  false],
  ['Daily Hotspot',   'hotspot', '24 Hours',  24,   40,   '2 Mbps',  '4 Mbps',  1,  true],
  ['Weekly Hotspot',  'hotspot', '7 Days',    168,  245,  '4 Mbps',  '4 Mbps',  3,  false],
  ['Monthly Hotspot', 'hotspot', '30 Days',   720,  1000, '6 Mbps',  '6 Mbps',  5,  false],
  ['Home Fiber 5M',   'fiber',   'Monthly',   720,  1500, '5 Mbps',  '5 Mbps',  5,  true],
  ['Home Fiber 10M',  'fiber',   'Monthly',   720,  2000, '10 Mbps', '10 Mbps', 10, false],
  ['Home Fiber 20M',  'fiber',   'Monthly',   720,  3000, '20 Mbps', '20 Mbps', 15, false],
]

const FIRST = ['Amina','Brian','Chelsea','Dennis','Esther','Faith','George','Halima','Isaac','Joy','Kevin','Lydia','Michael','Nadia','Oscar','Priya','Quinn','Rosa']
const LAST  = ['Otieno','Kamau','Wanjiku','Mwangi','Achieng','Odhiambo','Mutua','Njeri','Kibet','Chebet','Ouma','Atieno','Kiprono','Wafula','Muthoni','Simiyu','Barasa','Nyaga']
const DEVICE = ['iPhone 15 Pro','Samsung S24','Tecno Spark 20','Infinix Hot 30','Huawei P30','Xiaomi Redmi 13','OPPO A78','Tecno Camon 30','Samsung A15','iPhone 12']
/** Monotonic counter so seeded voucher codes never collide (mirrors the
 *  unique index on lower(code) in Postgres). */
let voucherSeq = 0
const makeVoucherCode = (prefix: string) =>
  `${prefix.toUpperCase()}-${String(++voucherSeq).padStart(6, '0')}`

const TICKETS: Array<[string, string, Ticket['priority']]> = [
  ['Speed drops in the evening', 'Speed Issue', 'high'],
  ['M-Pesa payment not reflecting', 'Payment Failed', 'urgent'],
  ['Fiber link down since morning', 'Router Offline', 'urgent'],
  ['Voucher code rejected', 'Voucher Code Error', 'medium'],
  ['Requesting a plan upgrade', 'Upgrade Request', 'low'],
  ['Monthly invoice query', 'Billing Query', 'low'],
]

function seedIsp(input: {
  name: string; slug: string; city: string; county: string; status: Isp['status']
  plan: Isp['plan']; color: string; clients: number; ownerEmail: string
  maxClients: number; maxPlans: number; maxNodes: number
  createdDaysAgo: number; trialEndsInDays?: number
}): SeedResult {
  const ispId = uid('isp')

  const isp: Isp = {
    id: ispId, name: input.name, slug: input.slug,
    status: input.status, plan: input.plan,
    contact_email: input.ownerEmail,
    contact_phone: `+254 7${String(10000000 + Math.floor(Math.random() * 8999999)).slice(0, 8)}`,
    country: 'KE', county: input.county, city: input.city,
    address: `${input.city}, ${input.county}`,
    brand_color: input.color, logo_url: null, portal_domain: `${input.slug}.co.ke`,
    max_clients: input.maxClients, max_plans: input.maxPlans, max_nodes: input.maxNodes,
    trial_ends_at: input.trialEndsInDays != null ? daysAhead(input.trialEndsInDays) : null,
    onboarded_at: input.status === 'trial' ? null : daysAgo(Math.max(1, input.createdDaysAgo - 2)),
    suspended_at: input.status === 'suspended' ? daysAgo(3) : null,
    created_at: daysAgo(input.createdDaysAgo), updated_at: daysAgo(1),
  }

  const owner: DemoUser = {
    id: uid('usr'), isp_id: ispId, role: 'isp_owner',
    full_name: `${pick(FIRST)} ${input.name.split(' ')[0]}`,
    phone: `+254 7${String(20000000 + Math.floor(Math.random() * 8999999)).slice(0, 8)}`,
    avatar_url: null, is_active: true,
    email: input.ownerEmail, password: 'Owner@1234',
  }

  const plans: Plan[] = CATALOGUE.slice(0, Math.min(CATALOGUE.length, input.maxPlans)).map((c) => ({
    id: uid('pln'), isp_id: ispId, name: c[0], kind: c[1], duration_label: c[2],
    duration_hours: c[3], price: c[4], speed_down: c[5], speed_up: c[6],
    shared_users: c[7], is_popular: c[8], data_limit: 'Unlimited', is_active: true,
  }))

const clients: Client[] = Array.from({ length: input.clients }, (_, i) => {
    const plan = pick(plans)
    const name = `${pick(FIRST)} ${pick(LAST)}`
    return {
      id: uid('cli'), isp_id: ispId,
      account_no: `${input.slug.slice(0, 3).toUpperCase()}-${1000 + i}`,
      full_name: name,
      phone: `07${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`,
      email: `${name.split(' ')[0].toLowerCase()}${i}@example.co.ke`,
      plan_name: plan?.name ?? 'Daily Hotspot',
      reseller_id: null,
      status: Math.random() > 0.18 ? 'active' : (Math.random() > 0.5 ? 'suspended' : 'expired'),
      balance: Math.random() > 0.7 ? Math.round(Math.random() * 3000) : 0,
      bandwidth: `${plan?.speed_down ?? '2 Mbps'} Symmetrical`,
      expires_at: daysAhead(Math.floor(Math.random() * 30) - 5),
      created_at: daysAgo(1 + Math.floor(Math.random() * input.createdDaysAgo)),
    }
  })

  const invoices: Invoice[] = []
  const payments: Payment[] = []

  for (let m = 3; m >= 0; m--) {
    clients.slice(0, Math.max(1, Math.floor(clients.length * 0.55))).forEach((c, idx) => {
      const plan = plans.find((p) => p.name === c.plan_name)
      const paid = m > 0 ? Math.random() > 0.12 : Math.random() > 0.7
      const invId = uid('inv')
      invoices.push({
        id: invId, isp_id: ispId, client_id: c.id,
        invoice_no: `INV-${new Date().getFullYear()}-${1000 + idx}${m}`,
        period_label: new Date(Date.now() - m * 30 * 864e5)
          .toLocaleDateString('en', { month: 'long', year: 'numeric' }),
        plan_name: c.plan_name, amount: plan?.price ?? 40,
        due_date: daysAgo(m * 30 + 5).slice(0, 10),
        status: paid ? 'paid' : (Math.random() > 0.5 ? 'overdue' : 'unpaid'),
        paid_at: paid ? daysAgo(m * 30) : null,
        created_at: daysAgo(m * 30 + 5),
      })
      if (paid) {
        payments.push({
          id: uid('pay'), isp_id: ispId, client_id: c.id, invoice_id: invId,
          phone: c.phone, amount: plan?.price ?? 40, method: 'mpesa', status: 'success',
          checkout_request_id: `demo_${Math.random().toString(36).slice(2, 12)}`,
          mpesa_receipt: String(100000 + Math.floor(Math.random() * 899999)),
          created_at: daysAgo(m * 30),
        })
      }
    })
  }

const vouchers: Voucher[] = Array.from({ length: 40 }, () => {
    const plan = pick(plans)
    const status = pick<Voucher['status']>(['unused', 'unused', 'unused', 'active', 'expired'])
    return {
      id: uid('vch'), isp_id: ispId, plan_id: plan?.id ?? null,
      code: makeVoucherCode(input.slug.slice(0, 4)),
      batch_prefix: input.slug.slice(0, 4).toUpperCase(), status,
      activated_by: status === 'active' ? 'captive-portal' : null,
      activated_at: status === 'active' ? daysAgo(Math.floor(Math.random() * 3)) : null,
      expires_at: new Date(Date.now() + plan!.duration_hours * 36e5).toISOString(),
      created_at: daysAgo(Math.floor(Math.random() * 20)),
    }
  })

  const nodes: Node[] = Array.from(
    { length: Math.min(input.maxNodes, 3 + Math.floor(Math.random() * 2)) },
    (_, i) => ({
      id: uid('nod'), isp_id: ispId,
      name: i === 0 ? `${input.name} Core Hub` : `${input.name} Node ${String.fromCharCode(65 + i)}`,
      host: `10.20.${i}.1`,
      // Router telemetry is only populated for nodes that have actually been
      // polled; the rest stay null so the UI reports "No data" rather than
      // inventing a CPU or uptime figure.
      model: null, os_version: null, serial_number: null,
      routeros_version: null,
      cpu_load: null, ram_used_mb: null, ram_total_mb: null,
      uptime_seconds: null, notes: null,
      status: i === 0 ? 'online' : pick<Node['status']>(['online', 'online', 'online', 'maintenance']),
      active_users: 20 + Math.floor(Math.random() * 400),
      load_percent: Math.floor(Math.random() * 95),
      capacity: i === 0 ? '10 Gbps' : '1 Gbps', last_seen: daysAgo(0),
    }),
  )

  const sessions: Session[] = Array.from({ length: 18 }, (_, i) => ({
    id: uid('ses'), isp_id: ispId, node_id: pick(nodes).id,
    voucher_code: vouchers[i]?.code ?? null,
    mac_address: Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':').toUpperCase(),
    ip_address: `10.150.${Math.floor(Math.random() * 5)}.${20 + Math.floor(Math.random() * 200)}`,
    device_type: pick(DEVICE),
    downloaded_mb: Math.floor(Math.random() * 12000),
    uploaded_mb: Math.floor(Math.random() * 3000),
    started_at: daysAgo(Math.random() * 0.5), ended_at: null,
  }))

  const tickets: Ticket[] = Array.from({ length: 6 }, () => {
    const t = pick(TICKETS)
    return {
      id: uid('tkt'), isp_id: ispId, client_id: pick(clients)?.id ?? null,
      subject: t[0], category: t[1], priority: t[2],
      status: pick<Ticket['status']>(['open', 'open', 'in_progress', 'resolved']),
      created_at: daysAgo(Math.floor(Math.random() * 14)),
      updated_at: daysAgo(Math.floor(Math.random() * 10)),
    }
  })

  const ticketMessages: TicketMessage[] = tickets.flatMap((t) => [
    { id: uid('msg'), ticket_id: t.id, sender: 'client' as const, body: t.subject, created_at: t.created_at },
    { id: uid('msg'), ticket_id: t.id, sender: 'system' as const,
      body: 'Ticket received by the ISP NOC. An engineer has been notified.', created_at: t.created_at },
  ])

  return { isp, owner, plans, clients, invoices, payments, vouchers, nodes, sessions, tickets, ticketMessages }
}

// ── Demo platform composition ──────────────────────────────────────────────────

/**
 * Demo data for every domain table, so the panel is fully explorable offline.
 * Mirrors the seed shapes in the SQL migrations.
 */
const PERMISSIONS: PermissionDefinition[] = (
  [
    ['customers.view', 'View customers', 'Customers'],
    ['customers.create', 'Create customers', 'Customers'],
    ['customers.edit', 'Edit customers', 'Customers'],
    ['customers.delete', 'Delete customers', 'Customers'],
    ['packages.view', 'View packages', 'Services'],
    ['packages.manage', 'Manage packages', 'Services'],
    ['vouchers.view', 'View vouchers', 'Services'],
    ['vouchers.manage', 'Manage vouchers', 'Services'],
    ['routers.view', 'View routers', 'Network'],
    ['routers.manage', 'Manage routers', 'Network'],
    ['sessions.view', 'View sessions', 'Network'],
    ['sessions.disconnect', 'Disconnect sessions', 'Network'],
    ['payments.view', 'View payments', 'Billing'],
    ['payments.manage', 'Manage payments', 'Billing'],
    ['invoices.view', 'View invoices', 'Billing'],
    ['invoices.manage', 'Manage invoices', 'Billing'],
    ['sms.send', 'Send SMS', 'Communication'],
    ['sms.bulk', 'Send bulk SMS', 'Communication'],
    ['sms.manage', 'Manage SMS templates', 'Communication'],
    ['resellers.view', 'View resellers', 'Sales'],
    ['resellers.manage', 'Manage resellers', 'Sales'],
    ['commissions.view', 'View commissions', 'Sales'],
    ['commissions.manage', 'Manage commissions', 'Sales'],
    ['expenses.view', 'View expenses', 'Business'],
    ['expenses.manage', 'Manage expenses', 'Business'],
    ['inventory.view', 'View inventory', 'Business'],
    ['inventory.manage', 'Manage inventory', 'Business'],
    ['reports.view', 'View reports', 'Business'],
    ['staff.manage', 'Manage staff', 'Team'],
    ['settings.manage', 'Manage settings', 'Settings'],
    ['api.manage', 'Manage API & webhooks', 'Settings'],
  ] as const
).map(([key, label, category]) => ({ key, label, category }))

const ALL_PERMS = PERMISSIONS.map((p) => p.key)

const ROLE_TEMPLATES: Array<[string, string, string[]]> = [
  ['administrator', 'ISP Administrator', ALL_PERMS],
  ['billing_officer', 'Billing Officer',
    ['customers.view', 'customers.edit', 'invoices.view', 'invoices.manage',
      'payments.view', 'payments.manage', 'sms.send', 'reports.view']],
  ['technician', 'Network Technician',
    ['routers.view', 'routers.manage', 'sessions.view', 'sessions.disconnect', 'customers.view']],
  ['support', 'Customer Support',
    ['customers.view', 'invoices.view', 'payments.view', 'sms.send', 'sms.bulk']],
  ['sales_agent', 'Sales Agent',
    ['customers.view', 'customers.create', 'payments.view', 'resellers.view', 'commissions.view']],
  ['reseller_manager', 'Reseller Manager',
    ['resellers.view', 'resellers.manage', 'commissions.view', 'commissions.manage', 'customers.view']],
]

const SMS_TEMPLATE_SEED: Array<[string, string, string]> = [
  ['welcome', 'Welcome message', 'Hi {{name}}, welcome to {{isp}}! Your account {{username}} is active on {{plan}}.'],
  ['payment_ok', 'Payment received', 'Hi {{name}}, we received KES {{amount}}. Your {{isp}} service is active until {{expiry}}.'],
  ['payment_failed', 'Payment failed', 'Hi {{name}}, your payment of KES {{amount}} could not be completed. Please try again.'],
  ['expiry_reminder', 'Expiry reminder', 'Hi {{name}}, your {{isp}} subscription expires in {{days}} days. Renew to stay online.'],
  ['expired', 'Expired', 'Hi {{name}}, your {{isp}} subscription has expired. Send KES {{amount}} to {{till}} to reactivate.'],
  ['suspended', 'Suspended', 'Hi {{name}}, your {{isp}} account has been suspended. Contact support on {{phone}}.'],
  ['reactivated', 'Reactivated', 'Hi {{name}}, your {{isp}} account is active again. Welcome back!'],
  ['renewal', 'Renewal confirmation', 'Hi {{name}}, your {{isp}} plan was renewed until {{expiry}}.'],
]

const EXPENSE_CATEGORIES = [
  'Bandwidth', 'Electricity', 'Salaries', 'Rent', 'Equipment',
  'Transport', 'Marketing', 'Maintenance', 'Licences', 'Other',
]

const INVENTORY_SEED: Array<[string, string, string, number, number]> = [
  ['RTR-CCR2004', 'Router CCR2004', 'Router', 12, 185000],
  ['RTR-HEX', 'Router hEX', 'Router', 6, 42000],
  ['AP-MP624', 'Access Point mAP 624', 'Access Point', 18, 31000],
  ['ONT-GPON', 'GPON ONT Terminal', 'ONT', 34, 7800],
  ['CAB-CAT6', 'Cat6 Patch Cable (box)', 'Cable', 60, 9500],
  ['PWR-24V', '24V PoE Power Supply', 'Power', 25, 4200],
  ['SPL-PLC', 'PLC Splitter', 'Accessory', 40, 2600],
]

const RESELLER_FIRST = ['Abdi', 'Caroline', 'Daniel', 'Esther', 'Fatuma', 'George', 'Halima', 'Ibrahim']
const RESELLER_LAST = ['Hassan', 'Kamau', 'Langat', 'Mwangi', 'Noor', 'Ochieng', 'Wanjala', 'Yusuf']

/**
 * Generates the domain rows for one tenant. Everything is stamped with that
 * tenant's id, which is what the isolation tests assert against.
 */
function seedDomains(
  db: DemoDb, ispId: string,
  clients: Client[], plans: Plan[], nodes: Node[], payments: Payment[],
) {
  const now = Date.now()
  const mine = clients.filter((c) => c.isp_id === ispId)
  const myPlans = plans.filter((p) => p.isp_id === ispId)
  const myNodes = nodes.filter((n) => n.isp_id === ispId)

  db.roles.push(...ROLE_TEMPLATES.map(([key, name, permissions]) => ({
    id: uid('rol'), isp_id: ispId, key, name,
    description: `${name} role for this ISP`, permissions, is_system: true,
  })))

  const resellers: Reseller[] = Array.from(
    { length: Math.max(2, Math.round(mine.length / 40)) },
    (_, i) => ({
      id: uid('rsl'), isp_id: ispId, user_id: null,
      code: `RSL-${String(i + 1).padStart(3, '0')}`,
      full_name: `${pick(RESELLER_FIRST)} ${pick(RESELLER_LAST)}`,
      phone: `07${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`,
      email: `reseller${i + 1}@example.co.ke`,
      commission_rate: [8, 10, 12, 15][i % 4],
      credit_limit: Math.round(Math.random() * 500000) + 50000,
      balance: Math.round(Math.random() * 40000),
      status: i === 0 ? 'suspended' : 'active',
      created_at: daysAgo(30 + Math.floor(Math.random() * 300)),
    }),
  )
  db.resellers.push(...resellers)
  const activeResellers = resellers.filter((r) => r.status === 'active')

  // Assign a share of customers to resellers
  mine.forEach((c, i) => {
    if (activeResellers.length && i % 3 === 0) {
      c.reseller_id = activeResellers[i % activeResellers.length].id
    }
  })

  const rClientIds = new Set(mine.filter((c) => c.reseller_id).map((c) => c.id))
  db.commissions.push(...payments
    .filter((p) => p.isp_id === ispId && p.status === 'success' && rClientIds.has(p.client_id!))
    .slice(0, 30)
    .map((p) => {
      const client = mine.find((c) => c.id === p.client_id)
      const r = resellers.find((x) => x.id === client?.reseller_id)!
      return {
        id: uid('com'), isp_id: ispId, reseller_id: r.id, payment_id: p.id,
        sale_amount: Number(p.amount), rate: r.commission_rate,
        amount: Math.round(Number(p.amount) * r.commission_rate) / 100,
        period: p.created_at.slice(0, 7),
        status: pick<Commission['status']>(['pending', 'approved', 'paid']),
        paid_at: null, created_at: p.created_at,
      }
    }))

  db.serviceAccounts.push(...mine.flatMap((c, i) => {
    const kind: ServiceAccount['service_type'] = i % 3 === 2 ? 'pppoe' : 'hotspot'
    return [{
      id: uid('svc'), isp_id: ispId, client_id: c.id,
      username: `${c.full_name.split(' ')[0].toLowerCase()}${c.account_no.slice(-3)}`,
      service_type: kind,
      plan_id: pick(myPlans)?.id ?? null,
      status: (c.status === 'active' ? 'active' : c.status === 'expired' ? 'expired' : 'suspended') as ServiceAccount['status'],
      ip_address: `100.64.${i % 250}.${10 + (i % 200)}`,
      mac_address: kind === 'hotspot'
        ? Array.from({ length: 6 }, () =>
            Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':').toUpperCase()
        : null,
      router_id: kind === 'pppoe' ? pick(myNodes)?.id ?? null : null,
      radius_user_id: kind === 'pppoe' ? `rad_${Math.floor(Math.random() * 1e8)}` : null,
      last_seen_at: daysAgo(Math.random() * 0.5),
      expires_at: c.expires_at, created_at: c.created_at,
    }]
  }))

db.renewals.push(...mine.slice(0, 25).map((c) => ({
    id: uid('ren'), isp_id: ispId, client_id: c.id,
    plan_id: pick(myPlans)?.id ?? null,
    previous_expiry: c.expires_at,
    new_expiry: new Date(now + 30 * 864e5).toISOString(),
    amount: pick(myPlans)?.price ?? 40,
    payment_id: null, note: 'Monthly renewal',
    created_at: daysAgo(Math.floor(Math.random() * 25)),
  })))

  db.transactions.push(
    ...payments.filter((p) => p.isp_id === ispId).slice(0, 40).map((p) => ({
      id: uid('trx'), isp_id: ispId, client_id: p.client_id,
      kind: 'payment' as const, direction: 'credit' as const,
      amount: Number(p.amount), reference: p.mpesa_receipt,
      memo: 'M-Pesa payment', payment_id: p.id, created_at: p.created_at,
    })),
    ...Array.from({ length: 8 }, () => ({
      id: uid('trx'), isp_id: ispId, client_id: null,
      kind: 'expense' as const, direction: 'debit' as const,
      amount: Math.round(Math.random() * 40000) + 2000,
      reference: null, memo: 'Operating cost', payment_id: null,
      created_at: daysAgo(Math.floor(Math.random() * 30)),
    })),
  )

  db.smsTemplates.push(...SMS_TEMPLATE_SEED.map(([key, name, body]) => ({
    id: uid('sms'), isp_id: ispId, key, name, body,
    variables: (body.match(/\{\{\w+\}\}/g) ?? []).map((v) => v.slice(2, -2)),
    is_active: true,
  })))
  db.smsMessages.push(...mine.slice(0, 18).map((c, i) => ({
    id: uid('msg'), isp_id: ispId, client_id: c.id,
    template_key: SMS_TEMPLATE_SEED[i % SMS_TEMPLATE_SEED.length][0],
    to_number: c.phone,
    body: SMS_TEMPLATE_SEED[i % SMS_TEMPLATE_SEED.length][2].replace(/\{\{\w+\}\}/g, '…'),
    status: pick<SmsMessage['status']>(['delivered', 'delivered', 'sent', 'failed', 'queued']),
    provider: 'demo', provider_id: null, error: null,
    segments: 2, cost: 1.5, sent_at: daysAgo(i), created_at: daysAgo(i),
  })))

  db.expenses.push(...Array.from({ length: 24 }, () => {
    const recurring = Math.random() > 0.7
    return {
      id: uid('exp'), isp_id: ispId,
      category: pick(EXPENSE_CATEGORIES),
      amount: Math.round(Math.random() * 90000) + 1500,
      date: new Date(now - Math.floor(Math.random() * 60) * 864e5).toISOString().slice(0, 10),
      supplier: pick(['Safaricom', 'Kenya Power', 'Starlink Fibre', 'Payroll', 'Makhani Hardware']),
      description: null,
      is_recurring: recurring,
      recurrence: recurring ? pick(['monthly', 'weekly', 'quarterly']) : null,
      recurring_until: recurring
        ? new Date(now + 365 * 864e5).toISOString().slice(0, 10) : null,
      created_at: daysAgo(Math.floor(Math.random() * 60)),
    }
  }))

  const items: InventoryItem[] = INVENTORY_SEED.map(([sku, name, category, qty, cost]) => ({
    id: uid('inv'), isp_id: ispId, sku, name, category, unit: 'pcs',
    quantity: qty, unit_cost: cost, reorder_level: 5, created_at: daysAgo(90),
  }))
  db.inventoryItems.push(...items)
  db.inventoryMovements.push(...items.flatMap((it) =>
    Array.from({ length: 3 }, () => {
      const kind = pick<InventoryMovement['kind']>(['purchase', 'issue', 'assign', 'return', 'damage'])
      return {
        id: uid('mov'), isp_id: ispId, item_id: it.id, kind,
        quantity: Math.max(1, Math.floor(Math.random() * 8) + 1),
        client_id: kind === 'assign' ? pick(mine)?.id ?? null : null,
        note: null, created_at: daysAgo(Math.floor(Math.random() * 60)),
      }
    })))
}

function buildSeed(): DemoDb {
  const db: DemoDb = {
    isps: [], profiles: [], plans: [], vouchers: [], clients: [], invoices: [],
    payments: [], nodes: [], sessions: [], tickets: [], ticketMessages: [], auditLogs: [],
    serviceAccounts: [], renewals: [], transactions: [],
    smsTemplates: [], smsMessages: [], resellers: [], commissions: [],
    expenses: [], inventoryItems: [], inventoryMovements: [], roles: [],
    permissionDefinitions: PERMISSIONS,
  }

  // The platform operator
  db.profiles.push({
    id: 'demo_super_admin', isp_id: null, role: 'super_admin',
    full_name: 'Platform Operator', phone: '+254 700 000 000',
    avatar_url: null, is_active: true,
    email: 'superadmin@ispflow.dev', password: 'Super@1234',
  })

  const tenants = [
    { name: 'Ultrafaiba Networks', slug: 'ultrafaiba', city: 'Nairobi',  county: 'Nairobi',   status: 'active',   plan: 'enterprise', color: '#7c3aed', clients: 420, ownerEmail: 'owner@ultrafaiba.co.ke', maxClients: 5000, maxPlans: 7,  maxNodes: 8,  createdDaysAgo: 210 },
    { name: 'Rift Valley Broadband', slug: 'riftvalley', city: 'Nakuru', county: 'Nakuru',   status: 'active',   plan: 'growth',    color: '#0891b2', clients: 145, ownerEmail: 'owner@riftvalley.co.ke', maxClients: 500,  maxPlans: 7,  maxNodes: 5,  createdDaysAgo: 120 },
    { name: 'Coastal Link', slug: 'coastal', city: 'Mombasa', county: 'Mombasa', status: 'trial',     plan: 'starter',  color: '#059669', clients: 38,  ownerEmail: 'owner@coastal.co.ke',     maxClients: 100,  maxPlans: 4,  maxNodes: 3,  createdDaysAgo: 6,   trialEndsInDays: 8 },
    { name: 'Highlands Fiber', slug: 'highlands', city: 'Eldoret', county: 'Uasin Gishu', status: 'suspended', plan: 'growth', color: '#d97706', clients: 62,  ownerEmail: 'owner@highlands.co.ke',   maxClients: 500,  maxPlans: 6,  maxNodes: 5,  createdDaysAgo: 75 },
  ] as const

  for (const t of tenants) {
    const seed = seedIsp(t)
    db.isps.push(seed.isp)
    db.profiles.push(seed.owner)

    // Give one tenant a second staff member so the team list is not empty.
    if (t.slug === 'ultrafaiba') {
      db.profiles.push({
        id: uid('usr'), isp_id: seed.isp.id, role: 'isp_agent',
        full_name: 'Support Agent', phone: '+254 733 111 222',
        avatar_url: null, is_active: true,
        email: 'agent@ultrafaiba.co.ke', password: 'Agent@1234',
      })
    }

    db.plans.push(...seed.plans)
    db.clients.push(...seed.clients)
    db.invoices.push(...seed.invoices)
    db.payments.push(...seed.payments)
    db.vouchers.push(...seed.vouchers)
    db.nodes.push(...seed.nodes)
    db.sessions.push(...seed.sessions)
    db.tickets.push(...seed.tickets)
    db.ticketMessages.push(...seed.ticketMessages)

    seedDomains(db, seed.isp.id, seed.clients, seed.plans, seed.nodes, seed.payments)
  }

  db.auditLogs = [
    { id: uid('aud'), actor_id: 'demo_super_admin', actor_email: 'superadmin@ispflow.dev', actor_role: 'super_admin', isp_id: db.isps[0].id, isp_name: db.isps[0].name, action: 'UPDATE:isp', target_type: 'isp', target_id: db.isps[0].id, metadata: { status: 'active', plan: 'enterprise' }, created_at: daysAgo(2) },
    { id: uid('aud'), actor_id: 'demo_super_admin', actor_email: 'superadmin@ispflow.dev', actor_role: 'super_admin', isp_id: db.isps[2].id, isp_name: db.isps[2].name, action: 'INSERT:isp', target_type: 'isp', target_id: db.isps[2].id, metadata: { status: 'trial', plan: 'starter' }, created_at: daysAgo(6) },
    { id: uid('aud'), actor_id: 'demo_super_admin', actor_email: 'superadmin@ispflow.dev', actor_role: 'super_admin', isp_id: db.isps[3].id, isp_name: db.isps[3].name, action: 'UPDATE:isp', target_type: 'isp', target_id: db.isps[3].id, metadata: { status: 'suspended', plan: 'growth' }, created_at: daysAgo(3) },
  ]

  return db
}

// ── Persistence ───────────────────────────────────────────────────────────────

let cache: DemoDb | null = null

export function loadDb(): DemoDb {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      cache = JSON.parse(raw) as DemoDb
      return cache
    }
  } catch {
    /* corrupted storage → rebuild */
  }
  cache = buildSeed()
  saveDb(cache)
  return cache
}

export function saveDb(db: DemoDb) {
  cache = db
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* quota exceeded — demo still works in-memory for this session */
  }
}

/** Wipe and regenerate the demo platform. Exposed via the UI "Reset demo" action. */
export function resetDb(): DemoDb {
  localStorage.removeItem(KEY)
  voucherSeq = 0
  cache = buildSeed()
  saveDb(cache)
  return cache
}

// ── Query + mutation helpers (tenant-scoped, mirroring RLS) ───────────────────

export function audit(
  action: string,
  actor: { id: string; email: string; role: Profile['role'] },
  isp: Isp | null,
  targetType?: string,
  targetId?: string,
  metadata: Record<string, unknown> = {},
) {
  const db = loadDb()
  db.auditLogs.unshift({
    id: uid('aud'), actor_id: actor.id, actor_email: actor.email,
    actor_role: actor.role, isp_id: isp?.id ?? null, isp_name: isp?.name ?? null,
    action, target_type: targetType ?? null, target_id: targetId ?? null,
    metadata, created_at: new Date().toISOString(),
  })
  saveDb(db)
}

/** Everything the super admin list screen needs, computed in one pass. */
export function demoIspStats(actor: { id: string; email: string; role: Profile['role'] }) {
  const db = loadDb()
  if (actor.role !== 'super_admin') return []
  const since = Date.now() - 30 * 864e5
  return db.isps.map((i) => ({
    ...i,
    staff_count: db.profiles.filter(
      (p) => p.isp_id === i.id && ['isp_owner', 'isp_admin', 'isp_agent'].includes(p.role)).length,
    active_clients: db.clients.filter((c) => c.isp_id === i.id && c.status === 'active').length,
    total_clients: db.clients.filter((c) => c.isp_id === i.id).length,
    plan_count: db.plans.filter((p) => p.isp_id === i.id).length,
    voucher_count: db.vouchers.filter((v) => v.isp_id === i.id).length,
    nodes_online: db.nodes.filter((n) => n.isp_id === i.id && n.status === 'online').length,
    revenue_30d: db.payments
      .filter((p) => p.isp_id === i.id && p.status === 'success'
        && new Date(p.created_at).getTime() >= since)
      .reduce((s, p) => s + Number(p.amount), 0),
    outstanding: db.invoices
      .filter((v) => v.isp_id === i.id && ['unpaid', 'overdue'].includes(v.status))
      .reduce((s, v) => s + Number(v.amount), 0),
    last_payment_at: db.payments
      .filter((p) => p.isp_id === i.id && p.status === 'success')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.created_at ?? null,
  }))
}

export function demoCreateIsp(
  actor: { id: string; email: string; role: Profile['role'] },
  input: {
    name: string; slug: string; phone: string; county: string; city: string
    plan: Isp['plan']; maxClients: number; maxPlans: number; maxNodes: number
  },
) {
  if (actor.role !== 'super_admin') throw new Error('Super admin privileges required')
  const db = loadDb()
  const slug = input.slug.toLowerCase().trim()
  if (slug.length < 3) throw new Error('Subdomain must be at least 3 characters.')
  if (db.isps.some((i) => i.slug === slug)) throw new Error('That subdomain is already taken.')

  const seed = seedIsp({
    name: input.name, slug, city: input.city || 'Nairobi', county: input.county || 'Nairobi',
    status: 'trial', plan: input.plan, color: '#7c3aed', clients: 0,
    ownerEmail: `${slug}@pending.co.ke`,
    maxClients: input.maxClients, maxPlans: input.maxPlans, maxNodes: input.maxNodes,
    createdDaysAgo: 0, trialEndsInDays: 14,
  })

  db.isps.push(seed.isp)
  db.profiles.push(seed.owner)
  db.plans.push(...seed.plans)
  db.nodes.push({
    id: uid('nod'), isp_id: seed.isp.id, name: `${seed.isp.name} Core Hub`,
    host: null, model: null, os_version: null, serial_number: null, routeros_version: null,
    cpu_load: null, ram_used_mb: null, ram_total_mb: null, uptime_seconds: null, notes: null,
    status: 'online', active_users: 0, load_percent: 0,
    capacity: '1 Gbps', last_seen: new Date().toISOString(),
  })
  saveDb(db)
  audit('INSERT:isp', actor, seed.isp, 'isp', seed.isp.id, { status: 'trial', plan: input.plan })
  return seed.isp
}

export function demoUpdateIsp(
  actor: { id: string; email: string; role: Profile['role'] },
  id: string,
  patch: Partial<Isp>,
) {
  if (actor.role !== 'super_admin') throw new Error('Super admin privileges required')
  const db = loadDb()
  const idx = db.isps.findIndex((i) => i.id === id)
  if (idx < 0) throw new Error('ISP not found')
  db.isps[idx] = { ...db.isps[idx], ...patch, updated_at: new Date().toISOString() }
  saveDb(db)
  audit('UPDATE:isp', actor, db.isps[idx], 'isp', id, {
    status: db.isps[idx].status, plan: db.isps[idx].plan,
  })
  return db.isps[idx]
}

export function demoDeleteIsp(actor: { id: string; email: string; role: Profile['role'] }, id: string) {
  if (actor.role !== 'super_admin') throw new Error('Super admin privileges required')
  const db = loadDb()
  const target = db.isps.find((i) => i.id === id)
  if (!target) throw new Error('ISP not found')

  // Cascade, mirroring the Postgres ON DELETE CASCADE
  const ticketIds = new Set(db.tickets.filter((t) => t.isp_id === id).map((t) => t.id))
  db.ticketMessages = db.ticketMessages.filter((m) => !ticketIds.has(m.ticket_id))
  db.profiles = db.profiles.filter((p) => p.isp_id !== id)
  db.plans = db.plans.filter((p) => p.isp_id !== id)
  db.vouchers = db.vouchers.filter((v) => v.isp_id !== id)
  db.clients = db.clients.filter((c) => c.isp_id !== id)
  db.invoices = db.invoices.filter((v) => v.isp_id !== id)
  db.payments = db.payments.filter((p) => p.isp_id !== id)
  db.nodes = db.nodes.filter((n) => n.isp_id !== id)
  db.sessions = db.sessions.filter((s) => s.isp_id !== id)
  db.tickets = db.tickets.filter((t) => t.isp_id !== id)
  db.isps = db.isps.filter((i) => i.id !== id)
  saveDb(db)
  audit('DELETE:isp', actor, target, 'isp', id, { name: target.name })
}

export function demoGenerateVouchers(
  ispId: string, planId: string, prefix: string, count: number,
): Voucher[] {
  const db = loadDb()
  const isp = db.isps.find((i) => i.id === ispId)
  const plan = db.plans.find((p) => p.id === planId)
  if (!isp) throw new Error('ISP not found')
  if (!plan) throw new Error('Plan not found')
  const cap = isp.plan === 'starter' ? 50 : isp.plan === 'growth' ? 500 : 100000
  if (count < 1 || count > 500) throw new Error('Count must be between 1 and 500')
  if (count > cap) throw new Error(`Your ${isp.plan} plan allows a maximum of ${cap} vouchers per batch.`)

  const created: Voucher[] = Array.from({ length: count }, () => ({
    id: uid('vch'), isp_id: ispId, plan_id: planId,
    code: makeVoucherCode(prefix || 'VCH'),
    batch_prefix: prefix.toUpperCase() || 'VCH', status: 'unused' as const,
    activated_by: null, activated_at: null,
    expires_at: new Date(Date.now() + plan.duration_hours * 36e5).toISOString(),
    created_at: new Date().toISOString(),
  }))
  db.vouchers.unshift(...created)
  saveDb(db)
  return created
}

export function demoRedeemVoucher(code: string) {
  const db = loadDb()
  const v = db.vouchers.find((x) => x.code.toLowerCase() === code.trim().toLowerCase())
  if (!v) return { success: false, message: 'Voucher not found on this platform.' }
  if (v.status === 'active') return { success: false, message: 'This voucher is already in use.' }
  if (v.status === 'disabled') return { success: false, message: 'This voucher has been disabled.' }
  if (v.status === 'expired' || (v.expires_at && new Date(v.expires_at) < new Date())) {
    v.status = 'expired'; saveDb(db)
    return { success: false, message: 'This voucher has expired.' }
  }
  v.status = 'active'
  v.activated_at = new Date().toISOString()
  v.activated_by = 'captive-portal'
  const plan = db.plans.find((p) => p.id === v.plan_id)
  const isp = db.isps.find((i) => i.id === v.isp_id)
  db.sessions.unshift({
    id: uid('ses'), isp_id: v.isp_id, node_id: null, voucher_code: v.code,
    mac_address: null, ip_address: null, device_type: 'Captive Portal Login',
    downloaded_mb: 0, uploaded_mb: 0, started_at: new Date().toISOString(), ended_at: null,
  })
  saveDb(db)
  return {
    success: true,
    message: `Access granted via ${plan?.name ?? 'voucher'}`,
    isp: isp?.name,
    plan: {
      name: plan?.name, speed: plan?.speed_down,
      duration: plan?.duration_label, dataLimit: plan?.data_limit,
    },
    expiresAt: v.expires_at,
  }
}

export function demoSetNodeStatus(nodeId: string, status: Node['status']) {
  const db = loadDb()
  const n = db.nodes.find((x) => x.id === nodeId)
  if (!n) throw new Error('Node not found')
  n.status = status
  n.active_users = status === 'online' ? 20 + Math.floor(Math.random() * 400) : 0
  n.load_percent = status === 'online' ? Math.floor(Math.random() * 95) : 0
  n.last_seen = new Date().toISOString()
  saveDb(db)
  return n
}

export function demoClearExpiredVouchers(ispId: string) {
  const db = loadDb()
  const before = db.vouchers.length
  db.vouchers = db.vouchers.filter((v) => !(v.isp_id === ispId && v.status === 'expired'))
  saveDb(db)
  return before - db.vouchers.length
}

export function demoAddTicket(
  ispId: string, subject: string, category: string,
  priority: Ticket['priority'], clientId: string | null = null,
) {
  const db = loadDb()
  const now = new Date().toISOString()
  const ticket: Ticket = {
    id: uid('tkt'), isp_id: ispId, client_id: clientId,
    subject, category, priority, status: 'open', created_at: now, updated_at: now,
  }
  db.tickets.unshift(ticket)
  db.ticketMessages.push(
    { id: uid('msg'), ticket_id: ticket.id, sender: 'client', body: subject, created_at: now },
    { id: uid('msg'), ticket_id: ticket.id, sender: 'system',
      body: 'Ticket received by the ISP NOC. An engineer has been notified.', created_at: now },
  )
  saveDb(db)
  return ticket
}

export function demoPayInvoice(invoiceId: string, phone?: string) {
  const db = loadDb()
  const inv = db.invoices.find((i) => i.id === invoiceId)
  if (!inv) throw new Error('Invoice not found')
  inv.status = 'paid'
  inv.paid_at = new Date().toISOString()
  db.payments.unshift({
    id: uid('pay'), isp_id: inv.isp_id, client_id: inv.client_id, invoice_id: inv.id,
    phone: phone ?? null, amount: Number(inv.amount), method: 'mpesa', status: 'success',
    checkout_request_id: `demo_${Math.random().toString(36).slice(2, 12)}`,
    mpesa_receipt: String(100000 + Math.floor(Math.random() * 899999)),
    created_at: new Date().toISOString(),
  })
  const c = inv.client_id ? db.clients.find((x) => x.id === inv.client_id) : null
  if (c) {
    c.status = 'active'
    c.balance = 0
    c.plan_name = inv.plan_name
    c.expires_at = new Date(Date.now() + 30 * 864e5).toISOString()
  }
  saveDb(db)
  return inv
}

export function demoUpgradePlan(clientId: string, planName: string) {
  const db = loadDb()
  const c = db.clients.find((x) => x.id === clientId)
  if (!c) throw new Error('Customer not found')
  const plan = db.plans.find((p) => p.isp_id === c.isp_id && p.name === planName)
  c.plan_name = planName
  c.bandwidth = `${plan?.speed_down ?? '2 Mbps'} Symmetrical`
  c.expires_at = new Date(Date.now() + 30 * 864e5).toISOString()
  saveDb(db)
  return c
}

export function demoKickSession(sessionId: string) {
  const db = loadDb()
  const s = db.sessions.find((x) => x.id === sessionId)
  if (!s) return null
  if (s.voucher_code) {
    const v = db.vouchers.find((x) => x.code === s.voucher_code)
    if (v) v.status = 'expired'
  }
  db.sessions = db.sessions.filter((x) => x.id !== sessionId)
  saveDb(db)
  return s
}

export function demoSetClientStatus(clientId: string, status: Client['status']) {
  const db = loadDb()
  const c = db.clients.find((x) => x.id === clientId)
  if (!c) throw new Error('Customer not found')
  c.status = status
  saveDb(db)
  return c
}

export function demoAddClient(
  ispId: string,
  input: { full_name: string; phone: string; email: string; plan_name: string },
) {
  const db = loadDb()
  const isp = db.isps.find((i) => i.id === ispId)
  if (!isp) throw new Error('ISP not found')
  if (db.clients.filter((c) => c.isp_id === ispId).length >= isp.max_clients) {
    throw new Error(`Your ${isp.plan} plan allows a maximum of ${isp.max_clients} customers.`)
  }
  const count = db.clients.filter((c) => c.isp_id === ispId).length
  const client: Client = {
    id: uid('cli'), isp_id: ispId,
    account_no: `${isp.slug.slice(0, 3).toUpperCase()}-${1000 + count}`,
    full_name: input.full_name, phone: input.phone, email: input.email,
    plan_name: input.plan_name, status: 'active', balance: 0,
    reseller_id: null, bandwidth: '2 Mbps Symmetrical',
    expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    created_at: new Date().toISOString(),
  }
  db.clients.unshift(client)
  saveDb(db)
  return client
}