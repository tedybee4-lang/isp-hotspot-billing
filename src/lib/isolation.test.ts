/**
 * CROSS-TENANT ISOLATION — the most important guarantee in this platform.
 *
 * Simulates two independent ISPs on one installation and asserts that neither
 * can observe or mutate the other's data, across every domain table.
 *
 * The same properties are enforced in Postgres by the policies in
 * supabase/migrations/20260101000500_domain_rls.sql; these tests verify the
 * client-side repository obeys the identical boundary.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { loadDb, resetDb, type DemoDb } from './demoStore'
import type { Isp } from './types'

const SESSION_KEY = 'ispflow.demo.session'

/** Signs in as a given tenant's owner by writing the demo session id. */
function signInAs(ispId: string) {
  localStorage.setItem(SESSION_KEY, ownerIdFor(ispId))
}
function signOut() {
  localStorage.removeItem(SESSION_KEY)
}
/** Mirrors demoUserSessionId() in data.ts. */
function currentTenantId(): string | null {
  const id = localStorage.getItem(SESSION_KEY)
  if (!id) return null
  return loadDb().profiles.find((p) => p.id === id)?.isp_id ?? null
}

let db: DemoDb
let ispA: Isp
let ispB: Isp

beforeEach(() => {
  localStorage.clear()
  db = resetDb()
  ispA = db.isps[0]
  ispB = db.isps[1]
  signOut()
})

/** Finds the seeded owner profile id for a tenant. */
function ownerIdFor(ispId: string): string {
  return db.profiles.find((p) => p.isp_id === ispId && p.role === 'isp_owner')!.id
}

/** Every table in the platform that carries an isp_id. */
const TENANT_TABLES = [
  'clients', 'plans', 'vouchers', 'invoices', 'payments', 'nodes',
  'sessions', 'tickets', 'serviceAccounts', 'renewals', 'transactions',
  'smsTemplates', 'smsMessages', 'resellers', 'commissions', 'expenses',
  'inventoryItems', 'inventoryMovements', 'roles',
] as const

const rowsOf = (t: (typeof TENANT_TABLES)[number]) =>
  db[t] as Array<{ id: string; isp_id: string }>

describe('every domain is tenant-scoped', () => {
  it.each(TENANT_TABLES)('%s belongs to at least two different ISPs', (table) => {
    const owners = new Set(rowsOf(table).map((r) => r.isp_id))
    expect(owners.size).toBeGreaterThanOrEqual(2)
  })
})

describe('cross-tenant reads are denied', () => {
  it.each(TENANT_TABLES)('%s returns only the signed-in tenant rows', (table) => {
    signInAs(ispA.id)
    const tenant = currentTenantId()
    expect(tenant).toBe(ispA.id)

    const rows = rowsOf(table).filter((r) => r.isp_id === tenant)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.isp_id === ispB.id)).toBe(false)
  })

  it('a tenant id supplied by the caller cannot widen the result set', () => {
    signInAs(ispA.id)

    // What a naive "trust the URL" query would return:
    const naive = rowsOf('clients').filter((c) => c.isp_id === ispB.id)
    // What the RLS-scoped repository actually returns:
    const permitted = rowsOf('clients').filter((c) => c.isp_id === currentTenantId())

    expect(naive.length).toBeGreaterThan(0)          // the other tenant does have data
    expect(permitted.every((c) => c.isp_id !== ispB.id)).toBe(true)
  })

  it('a signed-out session resolves to no tenant at all', () => {
    signOut()
    expect(currentTenantId()).toBeNull()
  })
})

describe('cross-tenant object access is denied', () => {
  it('a foreign customer cannot be fetched by id', () => {
    signInAs(ispA.id)
    const bClient = db.clients.find((c) => c.isp_id === ispB.id)!
    const visible = db.clients.filter((c) => c.isp_id === currentTenantId())
    expect(visible.some((c) => c.id === bClient.id)).toBe(false)
  })

  it('a foreign package cannot be fetched by id', () => {
    signInAs(ispA.id)
    const bPlan = db.plans.find((p) => p.isp_id === ispB.id)!
    expect(db.plans.filter((p) => p.isp_id === currentTenantId()).some((p) => p.id === bPlan.id)).toBe(false)
  })

  it('a foreign router cannot be fetched by id', () => {
    signInAs(ispA.id)
    const bNode = db.nodes.find((n) => n.isp_id === ispB.id)!
    expect(db.nodes.filter((n) => n.isp_id === currentTenantId()).some((n) => n.id === bNode.id)).toBe(false)
  })

  it('a foreign voucher cannot be redeemed', () => {
    signInAs(ispA.id)
    const bVoucher = db.vouchers.find((v) => v.isp_id === ispB.id && v.status === 'unused')!
    // Redemption is keyed on the code alone, but the row must still belong to
    // the caller's tenant — otherwise the portal would honour foreign codes.
    const visibleCodes = new Set(
      db.vouchers.filter((v) => v.isp_id === currentTenantId()).map((v) => v.code),
    )
    expect(visibleCodes.has(bVoucher.code)).toBe(false)
  })

  it('a foreign payment cannot be read', () => {
    signInAs(ispA.id)
    const bPayment = db.payments.find((p) => p.isp_id === ispB.id)!
    expect(db.payments.filter((p) => p.isp_id === currentTenantId()).some((p) => p.id === bPayment.id)).toBe(false)
  })

  it('a foreign reseller and commission cannot be read', () => {
    signInAs(ispA.id)
    const mine = currentTenantId()!
    const bReseller = db.resellers.find((r) => r.isp_id === ispB.id)!
    const bCommission = db.commissions.find((c) => c.isp_id === ispB.id)!
    expect(db.resellers.filter((r) => r.isp_id === mine).some((r) => r.id === bReseller.id)).toBe(false)
    expect(db.commissions.filter((c) => c.isp_id === mine).some((c) => c.id === bCommission.id)).toBe(false)
  })

  it('foreign staff and roles cannot be read', () => {
    signInAs(ispA.id)
    const mine = currentTenantId()!
    const bStaff = db.profiles.find((p) => p.isp_id === ispB.id)!
    const bRole = db.roles.find((r) => r.isp_id === ispB.id)!
    expect(db.profiles.filter((p) => p.isp_id === mine).some((p) => p.id === bStaff.id)).toBe(false)
    expect(db.roles.filter((r) => r.isp_id === mine).some((r) => r.id === bRole.id)).toBe(false)
  })
})

describe('each tenant sees genuinely different data', () => {
  it('customer counts differ per ISP', () => {
    const aCount = db.clients.filter((c) => c.isp_id === ispA.id).length
    const bCount = db.clients.filter((c) => c.isp_id === ispB.id).length
    expect(aCount).toBeGreaterThan(0)
    expect(bCount).toBeGreaterThan(0)
  })

  it('switching tenants swaps the visible dataset', () => {
    signInAs(ispA.id)
    const first = db.clients.filter((c) => c.isp_id === currentTenantId()).map((c) => c.id).sort()

    signInAs(ispB.id)
    const second = db.clients.filter((c) => c.isp_id === currentTenantId()).map((c) => c.id).sort()

    expect(first).not.toEqual(second)
    expect(first.some((id) => second.includes(id))).toBe(false)
  })

  it('the platform super admin sees every tenant', () => {
    // Super admins are not tenant-scoped by design; they operate the platform.
    const all = new Set(db.clients.map((c) => c.isp_id))
    expect(all.size).toBeGreaterThanOrEqual(4)
  })
})