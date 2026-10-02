/**
 * Behavioural tests for the demo backend.
 *
 * These run without a browser or a Supabase project, and they verify the two
 * things that matter most for a multi-tenant product: that the platform seeds
 * correctly, and that one tenant can never see or touch another's data.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  demoAddClient, demoClearExpiredVouchers, demoCreateIsp, demoDeleteIsp,
  demoGenerateVouchers, demoIspStats, demoKickSession, demoPayInvoice,
  demoRedeemVoucher, demoSetNodeStatus, demoUpdateIsp, loadDb, resetDb,
} from './demoStore'

const superAdmin = { id: 'demo_super_admin', email: 'superadmin@ispflow.dev', role: 'super_admin' as const }

beforeEach(() => {
  localStorage.clear()
  resetDb()
})

describe('platform seed', () => {
  it('creates the super admin plus several tenants', () => {
    const db = loadDb()
    expect(db.profiles.some((p) => p.role === 'super_admin')).toBe(true)
    expect(db.isps.length).toBeGreaterThanOrEqual(4)
    expect(db.isps.map((i) => i.status)).toContain('suspended')
    expect(db.isps.map((i) => i.status)).toContain('trial')
  })

  it('persists across reloads', () => {
    const before = loadDb().isps.length
    expect(loadDb().isps.length).toBe(before)
  })
})

describe('tenant isolation', () => {
  it('returns nothing to a non-super-admin', () => {
    const db = loadDb()
    const owner = db.profiles.find((p) => p.role === 'isp_owner')!
    expect(demoIspStats({ id: owner.id, email: owner.email, role: owner.role })).toEqual([])
  })

  it('every row is tagged with a real tenant', () => {
    const db = loadDb()
    const ids = new Set(db.isps.map((i) => i.id))
    const tables = ['plans', 'vouchers', 'clients', 'invoices', 'payments', 'nodes', 'sessions', 'tickets'] as const
    for (const table of tables) {
      for (const row of db[table]) {
        expect(ids.has(row.isp_id), `${table} row references unknown tenant`).toBe(true)
      }
    }
  })

  it('voucher codes are globally unique', () => {
    const codes = new Set<string>()
    for (const v of loadDb().vouchers) {
      expect(codes.has(v.code)).toBe(false)
      codes.add(v.code)
    }
  })
})

describe('super admin operations', () => {
  it('rejects non-super-admins', () => {
    expect(() => demoCreateIsp({ ...superAdmin, role: 'isp_agent' }, {
      name: 'X', slug: 'xxx', phone: '', county: '', city: '', plan: 'starter',
      maxClients: 1, maxPlans: 1, maxNodes: 1,
    })).toThrow(/Super admin/i)
  })

  it('creates a tenant with a starter catalogue', () => {
    const before = loadDb().isps.length
    const isp = demoCreateIsp(superAdmin, {
      name: 'Test Broadband', slug: 'test-bb', phone: '0700000000',
      county: 'Kisumu', city: 'Kisumu', plan: 'starter',
      maxClients: 50, maxPlans: 3, maxNodes: 2,
    })
    const db = loadDb()
    expect(db.isps.length).toBe(before + 1)
    expect(db.plans.filter((p) => p.isp_id === isp.id).length).toBeGreaterThan(0)
    expect(db.nodes.filter((n) => n.isp_id === isp.id).length).toBe(1)
    expect(isp.trial_ends_at).not.toBeNull()
  })

  it('rejects a duplicate subdomain', () => {
    expect(() => demoCreateIsp(superAdmin, {
      name: 'Dupe', slug: 'ultrafaiba', phone: '', county: '', city: '',
      plan: 'starter', maxClients: 1, maxPlans: 1, maxNodes: 1,
    })).toThrow(/already taken/i)
  })

  it('rejects a too-short subdomain', () => {
    expect(() => demoCreateIsp(superAdmin, {
      name: 'Short', slug: 'ab', phone: '', county: '', city: '',
      plan: 'starter', maxClients: 1, maxPlans: 1, maxNodes: 1,
    })).toThrow(/at least 3/i)
  })

  it('suspends and reactivates', () => {
    const target = loadDb().isps[0]
    demoUpdateIsp(superAdmin, target.id, { status: 'suspended' })
    expect(loadDb().isps.find((i) => i.id === target.id)!.status).toBe('suspended')
    demoUpdateIsp(superAdmin, target.id, { status: 'active' })
    expect(loadDb().isps.find((i) => i.id === target.id)!.status).toBe('active')
  })

  it('records an audit entry for lifecycle changes', () => {
    const before = loadDb().auditLogs.length
    demoUpdateIsp(superAdmin, loadDb().isps[0].id, { plan: 'enterprise' })
    const logs = loadDb().auditLogs
    expect(logs.length).toBe(before + 1)
    expect(logs[0].action).toBe('UPDATE:isp')
    expect(logs[0].actor_email).toBe('superadmin@ispflow.dev')
  })

  it('cascade-deletes every child record', () => {
    const victimId = loadDb().isps[0].id
    demoDeleteIsp(superAdmin, victimId)
    const db = loadDb()
    expect(db.isps.some((i) => i.id === victimId)).toBe(false)
    const tables = ['profiles', 'plans', 'vouchers', 'clients', 'invoices', 'payments', 'nodes', 'sessions', 'tickets'] as const
    for (const table of tables) {
      expect(db[table].some((r) => r.isp_id === victimId), `${table} left orphaned`).toBe(false)
    }
  })
})

describe('plan limits are enforced', () => {
  it('blocks customer creation past max_clients', () => {
    const isp = loadDb().isps.find((i) => i.slug === 'coastal')!
    const existing = loadDb().clients.filter((c) => c.isp_id === isp.id).length
    demoUpdateIsp(superAdmin, isp.id, { max_clients: existing })

    expect(() => demoAddClient(isp.id, {
      full_name: 'Over Limit', phone: '0700000001', email: 'x@y.z', plan_name: 'Daily Hotspot',
    })).toThrow(/maximum of/i)
  })

  it('caps voucher batches by tier', () => {
    const db = loadDb()
    const starter = db.isps.find((i) => i.plan === 'starter')!
    const plan = db.plans.find((p) => p.isp_id === starter.id)!

    expect(() => demoGenerateVouchers(starter.id, plan.id, 'TEST', 200)).toThrow(/maximum of 50/i)

    const batch = demoGenerateVouchers(starter.id, plan.id, 'TEST', 10)
    expect(batch).toHaveLength(10)
    expect(batch.every((v) => v.isp_id === starter.id && v.status === 'unused')).toBe(true)
  })
})

describe('voucher redemption', () => {
  it('rejects an unknown code', () => {
    expect(demoRedeemVoucher('NOPE-0000').success).toBe(false)
  })

  it('accepts an unused code exactly once', () => {
    const unused = loadDb().vouchers.find((v) => v.status === 'unused')!

    const first = demoRedeemVoucher(unused.code)
    expect(first.success).toBe(true)
    expect(loadDb().vouchers.find((v) => v.id === unused.id)!.status).toBe('active')

    const second = demoRedeemVoucher(unused.code)
    expect(second.success).toBe(false)
    expect(second.message).toMatch(/already in use/i)
  })

  it('records the resulting session', () => {
    const unused = loadDb().vouchers.find((v) => v.status === 'unused')!
    const before = loadDb().sessions.length
    demoRedeemVoucher(unused.code)
    expect(loadDb().sessions.length).toBe(before + 1)
  })

  it('is case-insensitive', () => {
    const unused = loadDb().vouchers.find((v) => v.status === 'unused')!
    expect(demoRedeemVoucher(unused.code.toLowerCase()).success).toBe(true)
  })

  it('rejects an already-expired code', () => {
    const expired = loadDb().vouchers.find((v) => v.status === 'expired')!
    expect(demoRedeemVoucher(expired.code).success).toBe(false)
  })
})

describe('operations stay inside their tenant', () => {
  it('kicking a session expires only its own voucher', () => {
    const session = loadDb().sessions.find((s) => s.voucher_code)!

    demoKickSession(session.id)

    const after = loadDb()
    expect(after.sessions.some((s) => s.id === session.id)).toBe(false)
    if (session.voucher_code) {
      expect(after.vouchers.find((v) => v.code === session.voucher_code)!.status).toBe('expired')
    }
    expect(after.sessions.some((s) => s.id !== session.id)).toBe(true)
  })

  it('clearing expired vouchers only touches one tenant', () => {
    const db = loadDb()
    const target = db.isps.find((i) =>
      db.vouchers.some((v) => v.isp_id === i.id && v.status === 'expired'))
    if (!target) return
    const othersExpired = db.vouchers.filter(
      (v) => v.isp_id !== target.id && v.status === 'expired').length

    const removed = demoClearExpiredVouchers(target.id)
    const after = loadDb()
    expect(after.vouchers.filter((v) => v.isp_id === target.id && v.status === 'expired')).toHaveLength(0)
    expect(after.vouchers.filter((v) => v.isp_id !== target.id && v.status === 'expired')).toHaveLength(othersExpired)
    expect(removed).toBeGreaterThan(0)
  })

  it('changing a node status leaves other tenants alone', () => {
    const node = loadDb().nodes[0]
    const otherOnline = loadDb().nodes.filter(
      (n) => n.isp_id !== node.isp_id && n.status === 'online').length

    demoSetNodeStatus(node.id, 'maintenance')

    const after = loadDb()
    expect(after.nodes.find((n) => n.id === node.id)!.status).toBe('maintenance')
    expect(after.nodes.filter((n) => n.isp_id !== node.isp_id && n.status === 'online')).toHaveLength(otherOnline)
  })
})

describe('platform stats', () => {
  it('aggregates per tenant', () => {
    const stats = demoIspStats(superAdmin)
    expect(stats).toHaveLength(loadDb().isps.length)
    for (const s of stats) {
      expect(s.active_clients).toBeLessThanOrEqual(s.total_clients)
      expect(s.total_clients).toBeLessThanOrEqual(s.max_clients)
      expect(s.staff_count).toBeGreaterThanOrEqual(1)
      expect(Number(s.revenue_30d)).toBeGreaterThanOrEqual(0)
    }
  })
})

// The manual Till / Paybill flow is how ISPs without Daraja API access collect.
describe('manual Till payment settlement', () => {
  const findUnpaid = () => {
    const db = loadDb()
    const inv = db.invoices.find((i) => i.status !== 'paid' && i.client_id)
    if (!inv) throw new Error('seed produced no unpaid invoice')
    return inv
  }

  it('settles the invoice and reactivates the customer', () => {
    const inv = findUnpaid()
    const clientId = inv.client_id!

    demoPayInvoice(inv.id, '0712345678')

    const db = loadDb()
    expect(db.invoices.find((i) => i.id === inv.id)!.status).toBe('paid')

    const client = db.clients.find((c) => c.id === clientId)!
    expect(client.status).toBe('active')
    expect(client.balance).toBe(0)
    expect(new Date(client.expires_at!).getTime()).toBeGreaterThan(Date.now())
  })

  it('records a successful receipt', () => {
    const inv = findUnpaid()
    demoPayInvoice(inv.id, '0712345678')

    const pay = loadDb().payments.find((p) => p.invoice_id === inv.id && p.status === 'success')
    expect(pay).toBeDefined()
    expect(pay!.method).toBe('mpesa')
    expect(pay!.mpesa_receipt).toBeTruthy()
  })

  it('rejects paying an unknown invoice', () => {
    expect(() => demoPayInvoice('does-not-exist')).toThrow(/not found/i)
  })

  it('only settles the invoice that was paid', () => {
    const target = findUnpaid()
    const otherId = loadDb().invoices.find(
      (i) => i.id !== target.id && i.status !== 'paid',
    )?.id
    expect(otherId).toBeDefined()

    demoPayInvoice(target.id)

    const db = loadDb()
    expect(db.invoices.find((i) => i.id === target.id)!.status).toBe('paid')
    expect(db.invoices.find((i) => i.id === otherId)!.status).not.toBe('paid')
  })
})