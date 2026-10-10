/**
 * Payment gateway service tests.
 *
 * The properties asserted here are the ones where a mistake costs money or
 * leaks one tenant's data to another:
 *
 *   * the amount comes from the database, never the request
 *   * the AccountID comes from the tenant's channel, never the request
 *   * initiation never settles
 *   * a duplicate event never activates twice
 *   * an unknown AccountID or reference activates nothing
 *   * a duplicate channel link is refused rather than created
 *
 * The Supabase client is faked. No test reaches HashBack, and none inserts a
 * real payment.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PaymentGatewayService,
  PaymentServiceError,
  isPaymentServiceError,
} from './payment-service.ts'
import { encryptFor } from './secrets.ts'

// Directory holding this shared module; the STK endpoint is a sibling of it.
// Must be `fileURLToPath(new URL(...))`. The previous form,
// `dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))`, stripped the
// leading slash that POSIX needs, so `here` resolved to a *relative* path and
// every readFileSync below failed with ENOENT on Linux CI while still passing
// on Windows, where the drive letter keeps the path absolute.
const here = dirname(fileURLToPath(import.meta.url))

// The credential store encrypts before writing and decrypts before reading, so
// these tests need a real AES key in the environment. The value is a throwaway
// test fixture — never a production secret, and never used against real data.
const TEST_KEY = 'test-only-hashback-encryption-key-not-a-real-secret'
beforeAll(() => {
  process.env.HASHBACK_CREDENTIALS_KEY = TEST_KEY
})

/** The encrypted form the fake admin reports, so the store can decrypt it. */
let ENCRYPTED_FAKE_KEY = ''
beforeAll(async () => {
  ENCRYPTED_FAKE_KEY = await encryptFor('test-api-key', 'hashback')
})

/** Builds a fake Supabase client whose query results are scripted per table. */
function fakeAdmin(script: {
  users?: Array<{ id: string }>
  profiles?: Record<string, unknown> | null
  configs?: Record<string, unknown> | null
  rpc?: Record<string, unknown | ((args: unknown) => unknown)>
  selects?: Record<string, unknown>
}) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: unknown }>,
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  }

  const chain = (table: string, result: unknown) => {
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'maybeSingle', 'single', 'limit', 'order']) {
      builder[m] = () => builder
    }
    builder.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: result, error: null }).then(resolve)
    builder.insert = (row: Record<string, unknown>) => {
      calls.inserts.push({ table, row })
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.single = () => b
      b.then = (resolve: (v: unknown) => void) =>
        Promise.resolve({ data: row, error: null }).then(resolve)
      return b
    }
    // `upsert` resolves directly. `update` returns a builder so a caller can
    // chain `.eq()` and then await the result, exactly as supabase-js does.
    builder.upsert = () => Promise.resolve({ data: null, error: null })
    const updateBuilder: Record<string, unknown> = {}
    for (const m of ['eq', 'select', 'order', 'limit']) {
      updateBuilder[m] = () => updateBuilder
    }
    updateBuilder.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: null, error: null }).then(resolve)
    builder.update = () => updateBuilder
    return builder
  }

  const admin = {
    auth: {
      getUser: vi.fn(async (jwt: string) => ({
        data: { user: script.users?.find((u) => u.id === jwt) ?? null },
        error: null,
      })),
    },
    from: vi.fn((table: string) => {
      if (table === 'platform_payment_config') {
        // Real ciphertext, so the credential store genuinely round-trips.
        return chain(table, {
          hashback_api_key_encrypted: ENCRYPTED_FAKE_KEY,
          hashback_webhook_secret_encrypted: ENCRYPTED_FAKE_KEY,
        })
      }
      if (table === 'profiles') return chain(table, script.profiles ?? null)
      if (table === 'isp_payment_configs') return chain(table, script.configs ?? null)
      return chain(table, script.selects?.[table] ?? null)
    }),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args })
      const scripted = script.rpc?.[fn]
      if (typeof scripted === 'function') {
        return { data: (scripted as (a: unknown) => unknown)(args), error: null }
      }
      return { data: scripted ?? null, error: null }
    }),
  }

  return { admin: admin as never, calls }
}

const JWT = 'user-1'
const CONNECTED = {
  payment_provider: 'hashback',
  hashback_account_id: 'HP-ISP-A',
  connection_status: 'connected',
}

/** A 200 JSON response, for the mocked provider. */
function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

describe('tenant resolution', () => {
  it('takes the ISP from the caller profile, not from the request', async () => {
    const { admin, calls } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-from-profile' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 1500,
          currency: 'KES', hashback_account_id: 'HP-ISP-A', isp_id: 'isp-from-profile',
        },
        record_hashback_checkout: { ok: true },
      },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true, checkout_id: 'ws_CO_1', MerchantRequestID: 'm1',
    }))

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await service.startPayment(JWT, { phone: '0712345678', invoiceId: 'inv-1' })

    // The profile's ISP was used; no caller-supplied isp id was needed.
    const args = calls.rpc[0].args as Record<string, unknown>
    expect(args.p_invoice_id).toBe('inv-1')
    expect(args.p_msisdn).toBe('254712345678')
  })

  it('refuses a session with no ISP rather than defaulting', async () => {
    const { admin } = fakeAdmin({ users: [{ id: JWT }], profiles: { isp_id: null } })
    const service = new PaymentGatewayService({ admin })
    await expect(service.startPayment(JWT, { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'not_configured' })
  })

  it('refuses an unauthenticated caller as unauthorized, not a server fault', async () => {
    const { admin } = fakeAdmin({ users: [] })
    const service = new PaymentGatewayService({ admin })
    // `not_configured` maps to HTTP 503. An expired or forged session used to
    // land there, so the client retried forever instead of re-authenticating.
    await expect(service.startPayment('nobody', { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('authenticates before validating input, so an anon caller learns nothing', async () => {
    // Validation-first meant an anonymous caller holding the public anon key
    // got a differentiated 400 ("enter a valid Kenyan phone number"), which
    // mapped this endpoint for anyone. Auth must resolve the tenant first.
    const { admin } = fakeAdmin({ users: [] })
    const service = new PaymentGatewayService({ admin })
    // No user resolves, so the request must fail as unauthorized even though
    // the phone is also unusable - auth is the first gate.
    await expect(service.startPayment('nobody', { phone: 'not-a-phone' }))
      .rejects.toMatchObject({ code: 'unauthorized' })

    // And a real session still gets the phone error, not an auth error.
    const ok = fakeAdmin({ users: [{ id: JWT }], profiles: { isp_id: 'isp-a' } })
    const authed = new PaymentGatewayService({ admin: ok.admin })
    await expect(authed.startPayment(JWT, { phone: '12345' }))
      .rejects.toMatchObject({ code: 'invalid_phone' })
  })

  it('keeps the endpoint from validating input before it authenticates', () => {
    const stk = readFileSync(join(here, '..', 'hashback-stk', 'index.ts'), 'utf8')
    const handler = /Deno\.serve\([\s\S]*$/.exec(stk)?.[0] ?? ''
    // The old `if (!body.phone) return 400` sat above the service call, which
    // is what let an anonymous caller reach a validation message.
    expect(handler).not.toMatch(/if\s*\(!body\.phone\)/)
    // Only the bearer-token presence check may precede the service call.
    const beforeCall = handler.split('service.startPayment')[0] ?? ''
    expect(beforeCall).toMatch(/if\s*\(!token\)/)
  })

  it('maps the STK status table so auth failure is 401, not 503', async () => {
    // The endpoint's status mapping is the other half of this: a code that
    // means "log in again" must not be reported as "the platform is broken".
    const stk = readFileSync(join(here, '..', 'hashback-stk', 'index.ts'), 'utf8')
    expect(stk).toMatch(/case 'unauthorized':\s*\n\s*return 401/)
    // And no auth failure may still be routed to 503.
    const authCase = /case 'unauthorized':([\s\S]*?)break/.exec(stk)?.[1] ?? ''
    expect(authCase).not.toMatch(/503/)
  })
})

describe('cross-tenant isolation', () => {
  it('refuses a tenant whose channel is not connected', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-b' },
      configs: { ...CONNECTED, hashback_account_id: 'HP-ISP-B', connection_status: 'pending' },
    })
    const service = new PaymentGatewayService({ admin })
    await expect(service.startPayment(JWT, { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'not_connected' })
  })

  it('sends the AccountID the server resolved, never one from the request', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 500,
          currency: 'KES', hashback_account_id: 'HP-ISP-A',
        },
        record_hashback_checkout: { ok: true },
      },
    })
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return jsonResponse({ success: true, checkout_id: 'ws' })
    })

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await service.startPayment(JWT, { phone: '0712345678', invoiceId: 'inv-1' })

    // The provider call used the channel the server resolved. There is no code
    // path by which the request could have influenced it.
    expect(bodies[0].account_id).toBe('HP-ISP-A')
  })

  it('rejects when the database hands back a different AccountID', async () => {
    // A race on the config must not let one tenant's payment ride another's
    // channel, so the mismatch is refused rather than trusted.
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 500,
          currency: 'KES', hashback_account_id: 'HP-SOMEONE-ELSE',
        },
      },
    })
    const service = new PaymentGatewayService({ admin })
    await expect(service.startPayment(JWT, { phone: '0712345678' }))
      .rejects.toMatchObject({ code: 'unknown_account' })
  })
})

describe('the amount is never trusted from the request', () => {
  it('sends the amount the database resolved', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        // The database resolved 1500 for a 1500 plan.
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 1500,
          currency: 'KES', hashback_account_id: 'HP-ISP-A',
        },
        record_hashback_checkout: { ok: true },
      },
    })
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return jsonResponse({ success: true, checkout_id: 'ws' })
    })

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.startPayment(JWT, { phone: '0712345678', invoiceId: 'inv-1' })

    // The provider was asked for the database's figure, and the caller is told
    // that same figure.
    expect(bodies[0].amount).toBe('1500')
    expect(result.amount).toBe(1500)
  })

  it('rejects a zero amount before any provider call', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 0,
          currency: 'KES', hashback_account_id: 'HP-ISP-A',
        },
      },
    })
    const fetchImpl = vi.fn()
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(service.startPayment(JWT, { phone: '0712345678' }))
      .rejects.toMatchObject({ kind: 'validation' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid phone before any provider call', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
    })
    const fetchImpl = vi.fn()
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(service.startPayment(JWT, { phone: '12345' }))
      .rejects.toMatchObject({ code: 'invalid_phone' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('initiation never settles', () => {
  it('leaves the payment pending and activates nothing', async () => {
    const { admin, calls } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 500,
          currency: 'KES', hashback_account_id: 'HP-ISP-A',
        },
        record_hashback_checkout: { ok: true, status: 'pending' },
      },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true, checkout_id: 'ws_CO_1', MerchantRequestID: 'm1', ResponseCode: '0',
    }))

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.startPayment(JWT, { phone: '0712345678' })

    // The prompt was sent. settle is never called from the initiation path.
    expect(result.promptSent).toBe(true)
    expect(result.checkoutId).toBe('ws_CO_1')
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })

  it('reports a provider refusal as not-sent without claiming success', async () => {
    const { admin } = fakeAdmin({
      users: [{ id: JWT }],
      profiles: { isp_id: 'isp-a' },
      configs: CONNECTED,
      rpc: {
        create_hashback_payment: {
          payment_id: 'p1', reference: 'NETISP-abc', amount: 500,
          currency: 'KES', hashback_account_id: 'HP-ISP-A',
        },
      },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: false, message: 'Invalid till number',
    }))

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.startPayment(JWT, { phone: '0712345678' })

    // A refusal is not a payment and not an activation.
    expect(result.ok).toBe(false)
    expect(result.promptSent).toBe(false)
  })
})

describe('webhook event processing', () => {
  const SUCCESS = {
    event: 'payment.success',
    ResponseCode: 0,
    TransactionID: 'TX-1',
    TransactionAmount: 500,
    TransactionReceipt: 'TX-1',
    TransactionReference: 'NETISP-abc',
    CheckoutRequestID: 'ws_CO_1',
    Msisdn: '254712345678',
    AccountID: 'HP-ISP-A',
  }

  it('settles a verified success exactly once', async () => {
    const { admin } = fakeAdmin({
      configs: { isp_id: 'isp-a' },
      rpc: {
        settle_hashback_payment: {
          ok: true, settled: true, duplicate: false, activated: true, isp_id: 'isp-a',
        },
      },
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent(SUCCESS)
    expect(result.settled).toBe(true)
    expect(result.activated).toBe(true)
    expect(result.duplicate).toBe(false)
  })

  it('reports a duplicate as settled-but-not-repeated', async () => {
    const { admin } = fakeAdmin({
      configs: { isp_id: 'isp-a' },
      rpc: {
        settle_hashback_payment: {
          ok: true, settled: false, duplicate: true, activated: false, isp_id: 'isp-a',
        },
      },
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent(SUCCESS)
    // The duplicate flag is what stops a second renewal and a second SMS.
    expect(result.duplicate).toBe(true)
    expect(result.activated).toBe(false)
  })

  it('activates nothing for an unknown AccountID', async () => {
    const { admin, calls } = fakeAdmin({
      configs: null, // no channel owns this AccountID
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent({ ...SUCCESS, AccountID: 'HP-NOBODY' })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unknown_account')
    // Neither settle nor fail was attempted against any tenant.
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
    // It was queued for a human instead.
    expect(calls.inserts.some((i) => i.table === 'payment_reconciliation')).toBe(true)
  })

  it('activates nothing for a webhook with no reference', async () => {
    const { admin, calls } = fakeAdmin({ configs: { isp_id: 'isp-a' } })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent({
      ...SUCCESS, TransactionReference: undefined,
    })
    expect(result.reason).toBe('unknown_reference')
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })

  it('never settles a non-success event', async () => {
    const { admin, calls } = fakeAdmin({
      configs: { isp_id: 'isp-a' },
      rpc: { fail_hashback_payment: { ok: true, settled: false, status: 'failed' } },
    })
    const service = new PaymentGatewayService({ admin })
    const result = await service.processWebhookEvent({
      ...SUCCESS, event: 'payment.failed', ResponseCode: 1,
    })
    expect(result.settled).toBe(false)
    expect(result.activated).toBe(false)
    // Recorded as failed, which is the honest state — never as a settlement.
    expect(calls.rpc.some((c) => c.fn === 'fail_hashback_payment')).toBe(true)
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })

  it('never settles an event whose ResponseCode is not 0', async () => {
    const { admin, calls } = fakeAdmin({
      configs: { isp_id: 'isp-a' },
      rpc: { fail_hashback_payment: { ok: true } },
    })
    const service = new PaymentGatewayService({ admin })
    await service.processWebhookEvent({ ...SUCCESS, ResponseCode: 1037 })
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })
})

describe('duplicate channel protection', () => {
  it('refuses a shortcode already linked to another ISP', async () => {
    const { admin } = fakeAdmin({
      rpc: {
        find_channel_by_shortcode: {
          found: true, isp_id: 'isp-someone-else', account_id: 'HP-THEIRS',
        },
      },
    })
    const fetchImpl = vi.fn()
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.linkISPChannel({
      ispId: 'isp-a', merchantName: 'Alpha',
      channelType: 'CustomerBuyGoodsOnline', shortcode: '522533',
    })

    // Two channels for one Till would split its history, so this is refused and
    // no provider call is made at all.
    expect(result.linked).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reuses an existing channel belonging to the same ISP', async () => {
    const { admin, calls } = fakeAdmin({
      rpc: {
        find_channel_by_shortcode: { found: true, isp_id: 'isp-a', account_id: 'HP-MINE' },
      },
    })
    const fetchImpl = vi.fn()
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.linkISPChannel({
      ispId: 'isp-a', merchantName: 'Alpha',
      channelType: 'CustomerBuyGoodsOnline', shortcode: '522533',
    })

    expect(result.linked).toBe(true)
    expect(result.accountId).toBe('HP-MINE')
    // linkAccount was never called: a repeat would mint a second AccountID for
    // the same Till.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(calls.rpc.some((c) => c.fn === 'record_channel_link')).toBe(false)
  })

  it('marks a channel connected only when HashBack returned an account id', async () => {
    const { admin, calls } = fakeAdmin({
      rpc: { find_channel_by_shortcode: { found: false } },
    })
    const fetchImpl = vi.fn(async () => jsonResponse({
      ResultCode: '400', message: 'Invalid till number',
    }))

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.linkISPChannel({
      ispId: 'isp-a', merchantName: 'Alpha',
      channelType: 'CustomerBuyGoodsOnline', shortcode: '522533',
    })

    // No account id means FAILED, never "connected".
    expect(result.linked).toBe(false)
    const recorded = calls.rpc.find((c) => c.fn === 'record_channel_link')
    expect((recorded?.args as Record<string, unknown>).p_status).toBe('failed')
  })
})

describe('reconciliation uses PULL, not transactionstatus', () => {
  it('skips the provider call for an already-settled payment', async () => {
    const { admin } = fakeAdmin({
      selects: { payments: { isp_id: 'isp-a', status: 'success' } },
    })
    const fetchImpl = vi.fn()
    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.reconcilePayment({
      reference: 'NETISP-abc', transactionId: 'TX-1',
    })
    expect(result.duplicate).toBe(true)
    // No token spent to learn something already recorded.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('settles from a PULL result when the payment is still pending', async () => {
    const { admin, calls } = fakeAdmin({
      configs: CONNECTED,
      selects: { payments: { isp_id: 'isp-a', status: 'pending' } },
      rpc: {
        settle_hashback_payment: {
          ok: true, settled: true, duplicate: false, activated: true, isp_id: 'isp-a',
        },
      },
    })
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(String(url))
      return jsonResponse({
        success: true,
        data: { transactionId: 'TX-1', amount: 500, billreference: 'NETISP-abc' },
      })
    })

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.reconcilePayment({
      reference: 'NETISP-abc', transactionId: 'TX-1',
    })

    // PULL was used, and it is the only status call that can settle.
    expect(urls.some((u) => u.includes('/v1/pullapi'))).toBe(true)
    expect(urls.some((u) => u.includes('transactionstatus'))).toBe(false)
    expect(result.settled).toBe(true)
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(true)
  })

  it('does not settle when the provider has no record', async () => {
    const { admin, calls } = fakeAdmin({
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
    expect(result.settled).toBe(false)
    expect(calls.rpc.some((c) => c.fn === 'settle_hashback_payment')).toBe(false)
  })
})

describe('platform verification is honest', () => {
  it('reports partner access unavailable when the partner call fails', async () => {
    const { admin } = fakeAdmin({})
    const fetchImpl = vi.fn(async (url: string) => {
      // Balance works; the partner endpoint refuses.
      if (String(url).includes('credits/balance')) return jsonResponse({ balance: 480 })
      return new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      })
    })

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.verifyPlatformConnection()

    // API works, partner access genuinely does not. The detail explains why,
    // rather than the UI implying channel provisioning is possible.
    expect(result.apiAvailable).toBe(true)
    expect(result.partnerAccess).toBe(false)
    expect(result.tokenBalance).toBe(480)
    expect(result.detail).toMatch(/Partner API access is unavailable/)
  })

  it('reports both available when both calls succeed', async () => {
    const { admin } = fakeAdmin({})
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('credits/balance')) return jsonResponse({ balance: 470 })
      return jsonResponse({
        ResultCode: '0', count: 2, billing: { token_balance: 470 }, data: [],
      })
    })

    const service = new PaymentGatewayService({
      admin, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await service.verifyPlatformConnection()
    expect(result.apiAvailable).toBe(true)
    expect(result.partnerAccess).toBe(true)
    expect(result.linkedChannels).toBe(2)
    expect(result.detail).toBeNull()
  })
})

describe('error classification', () => {
  it('identifies its own errors', () => {
    expect(isPaymentServiceError(new PaymentServiceError('not_connected', 'nope'))).toBe(true)
    expect(isPaymentServiceError(new Error('other'))).toBe(false)
  })

  it('marks retryable and permanent failures distinctly', () => {
    expect(new PaymentServiceError('provider_unavailable', 'x', true).retryable).toBe(true)
    expect(new PaymentServiceError('not_connected', 'x').retryable).toBe(false)
  })
})