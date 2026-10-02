/**
 * Settlement and cross-tenant guarantees.
 *
 * These assert properties that live in SQL rather than in TypeScript, so what is
 * checked here is the *shape* of the calls the service makes: which function
 * settles, which identifiers are forwarded, and that the service never bypasses
 * the idempotent database path.
 *
 * The SQL behaviour itself (settlement exactly once, RADIUS enqueued once, one
 * SMS per payment) is verified against the live database separately, not
 * asserted here.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { PaymentGatewayService } from './payment-service.ts'
import { encryptFor } from './secrets.ts'

const TEST_KEY = 'test-only-hashback-encryption-key-not-a-real-secret'
let ENCRYPTED = ''
beforeAll(async () => {
  process.env.HASHBACK_CREDENTIALS_KEY = TEST_KEY
  ENCRYPTED = await encryptFor('test-api-key', 'hashback')
})

const CONNECTED = {
  payment_provider: 'hashback',
  hashback_account_id: 'HP-ISP-A',
  connection_status: 'connected',
}

const SUCCESS_EVENT = {
  event: 'payment.success',
  ResponseCode: 0,
  AccountID: 'HP-ISP-A',
  TransactionReference: 'NETISP-abc',
  TransactionID: 'TX-1',
  TransactionAmount: 500,
}

/** A 200 JSON response, for the mocked provider. */
function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

interface Script {
  users?: Array<{ id: string }>
  profiles?: Record<string, unknown> | null
  configs?: Record<string, unknown> | null
  selects?: Record<string, unknown>
  rpc?: Record<string, unknown | ((args: unknown) => unknown)>
}

function adminWith(script: Script) {
  const calls = { rpc: [] as Array<{ fn: string; args: unknown }> }

  const chain = (table: string, result: unknown) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'maybeSingle', 'single', 'limit', 'order']) {
      b[m] = () => b
    }
    b.then = (r: (v: unknown) => void) =>
      Promise.resolve({ data: result, error: null }).then(r)
    b.insert = () => b
    b.upsert = () => Promise.resolve({ data: null, error: null })
    return b
  }

  return {
    calls,
    admin: {
      auth: {
        getUser: vi.fn(async (jwt: string) => ({
          data: { user: script.users?.find((u) => u.id === jwt) ?? null },
          error: null,
        })),
      },
      from: (table: string) => {
        if (table === 'platform_payment_config') {
          return chain(table, {
            hashback_api_key_encrypted: ENCRYPTED,
            hashback_webhook_secret_encrypted: ENCRYPTED,
          })
        }
        if (table === 'profiles') return chain(table, script.profiles ?? null)
        if (table === 'isp_payment_configs') return chain(table, script.configs ?? null)
        return chain(table, script.selects?.[table] ?? null)
      },
      rpc: async (fn: string, args: unknown) => {
        calls.rpc.push({ fn, args })
        const s = script.rpc?.[fn]
        return {
          data: typeof s === 'function' ? (s as (a: unknown) => unknown)(args) : s ?? null,
          error: null,
        }
      },
    } as never,
  }
}

describe('settlement goes through the idempotent database path', () => {
  it('routes a webhook settlement to settle_hashback_payment, not a direct write', async () => {
    const { admin, calls } = adminWith({
      configs: { isp_id: 'isp-a' },
      rpc: { settle_hashback_payment: { settled: true, duplicate: false, activated: true } },
    })
    const service = new PaymentGatewayService({ admin })
    await service.processWebhookEvent(SUCCESS_EVENT)

    // The database owns settlement and activation. The service never writes to
    // clients or invoices itself, so there is exactly one place where "paid" can
    // be decided — and that place is idempotent.
    expect(calls.rpc.map((c) => c.fn)).toContain('settle_hashback_payment')
  })

  it('passes every provider identifier the idempotency logic keys on', async () => {
    const { admin, calls } = adminWith({
      configs: { isp_id: 'isp-a' },
      rpc: { settle_hashback_payment: { settled: true } },
    })
    const service = new PaymentGatewayService({ admin })
    await service.processWebhookEvent({
      ...SUCCESS_EVENT,
      TransactionReceipt: 'RCP-9',
      CheckoutRequestID: 'ws_CO_9',
      MerchantRequestID: 'MR-9',
      // The documented payload carries Msisdn as a JSON number.
      Msisdn: 254712345678,
    })

    const call = calls.rpc.find((c) => c.fn === 'settle_hashback_payment')
    const args = (call?.args ?? {}) as Record<string, unknown>
    expect(args.p_transaction_id).toBe('TX-1')
    expect(args.p_receipt).toBe('RCP-9')
    expect(args.p_checkout_id).toBe('ws_CO_9')
    expect(args.p_merchant_request_id).toBe('MR-9')
    expect(args.p_msisdn).toBe('254712345678')
  })

  it('stores the raw provider payload so a dispute can be audited', async () => {
    const { admin, calls } = adminWith({
      configs: { isp_id: 'isp-a' },
      rpc: { settle_hashback_payment: { settled: true } },
    })
    const service = new PaymentGatewayService({ admin })
    await service.processWebhookEvent(SUCCESS_EVENT)

    const call = calls.rpc.find((c) => c.fn === 'settle_hashback_payment')
    const args = (call?.args ?? {}) as { p_provider_metadata: Record<string, unknown> }
    // The provider's own words are kept verbatim rather than a summary of them.
    expect(args.p_provider_metadata).toMatchObject(SUCCESS_EVENT)
  })
})

describe('a disabled or non-HashBack channel cannot collect', () => {
  it('refuses when the tenant turned collection off', async () => {
    const { admin, calls } = adminWith({
      users: [{ id: 'u1' }],
      profiles: { isp_id: 'isp-a' },
      configs: { ...CONNECTED, connection_status: 'disabled' },
    })
    const service = new PaymentGatewayService({ admin })
    await expect(service.startPayment('u1', { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'not_connected' })
    // No payment row is created for a channel that cannot collect.
    expect(calls.rpc.some((c) => c.fn === 'create_hashback_payment')).toBe(false)
  })

  it('refuses when the provider is not hashback at all', async () => {
    const { admin } = adminWith({
      users: [{ id: 'u1' }],
      profiles: { isp_id: 'isp-a' },
      configs: { payment_provider: 'manual', hashback_account_id: null },
    })
    const service = new PaymentGatewayService({ admin })
    await expect(service.startPayment('u1', { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'not_connected' })
  })
})

describe('cross-tenant webhook routing is blocked by AccountID', () => {
  it("will not apply one tenant channel's event to another tenant", async () => {
    const { admin, calls } = adminWith({
      configs: { isp_id: 'isp-b' },
      rpc: {
        settle_hashback_payment: (args: unknown) => {
          const a = args as Record<string, unknown>
          // The database refuses a settle carrying a foreign AccountID.
          if (a.p_account_id !== 'HP-ISP-B') {
            return { ok: false, settled: false, reason: 'unknown_reference' }
          }
          return { ok: true, settled: true, activated: true, isp_id: 'isp-b' }
        },
      },
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent(SUCCESS_EVENT)

    // Nothing was activated for ISP B from ISP A's channel.
    expect(result.settled).toBe(false)
    expect(result.activated).toBe(false)
    expect(calls.rpc.some((c) => c.fn === 'fail_hashback_payment')).toBe(false)
  })
})

describe('pending and failed payments never provision', () => {
  it('does not settle a webhook reporting a failure code', async () => {
    const { admin, calls } = adminWith({
      configs: { isp_id: 'isp-a' },
      rpc: { fail_hashback_payment: { ok: true, status: 'failed' } },
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent({
      ...SUCCESS_EVENT, ResponseCode: 1037,   // cancelled by user
    })
    expect(result.settled).toBe(false)
    expect(result.activated).toBe(false)
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })

  it('does not reconcile a payment the provider has no record of', async () => {
    const { admin, calls } = adminWith({
      configs: CONNECTED,
      selects: { payments: { isp_id: 'isp-a', status: 'pending' } },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: false, message: 'Transaction not found',
    }))
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.reconcilePayment({
      reference: 'NETISP-abc', transactionId: 'TX-NOT-REAL',
    })
    // A missing provider record is not a payment. Nothing is settled.
    expect(result.settled).toBe(false)
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })

  it('reconciles a pending payment from a real PULL result', async () => {
    const { admin } = adminWith({
      configs: CONNECTED,
      selects: { payments: { isp_id: 'isp-a', status: 'pending' } },
      rpc: {
        settle_hashback_payment: {
          ok: true, settled: true, activated: true, isp_id: 'isp-a',
        },
      },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true, data: { transactionId: 'TX-1', amount: 500 },
    }))
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.reconcilePayment({
      reference: 'NETISP-abc', transactionId: 'TX-1',
    })
    // This is the recovery path for a lost webhook, and it settles.
    expect(result.settled).toBe(true)
    expect(result.activated).toBe(true)
  })
})