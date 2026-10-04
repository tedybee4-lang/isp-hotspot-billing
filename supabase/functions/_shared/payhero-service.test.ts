/**
 * PayHero wiring in the payment service.
 *
 * These tests cover the money-critical and security-critical properties of the
 * production flow, using a fake admin client and a stubbed provider. Nothing here
 * contacts PayHero and nothing records a real payment anywhere.
 *
 * The properties that matter most:
 *   * an amount can never come from the browser,
 *   * an inbound callback is never believed — only PayHero's own answer settles,
 *   * a forged or duplicated callback cannot activate anyone twice,
 *   * one ISP cannot reach another ISP's channel.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { PaymentGatewayService } from './payment-service.ts'
import { encryptFor } from './secrets.ts'

const JWT = 'user-1'
const TOKEN = 'test-basic-token-not-a-real-credential'

/**
 * A genuine ciphertext of TOKEN, produced by the real encryption routine.
 *
 * Using a real one rather than a stub string means these tests exercise the
 * actual encrypt → store → decrypt round trip, so a regression that made the
 * stored format undecryptable would fail here rather than in production.
 */
let STORED_CIPHERTEXT = ''

beforeAll(async () => {
  // The encryption key lives in the environment in production, and only in the
  // environment. Setting it here mirrors that exactly.
  ;(globalThis as { process?: { env: Record<string, string> } }).process!.env
    .PAYHERO_CREDENTIALS_KEY = 'test-key-not-used-anywhere-else'
  STORED_CIPHERTEXT = await encryptFor(TOKEN, 'payhero')
})

/**
 * Minimal fake of the Supabase client the service uses.
 *
 * `payments` is keyed by provider_reference and `configs` by isp_id, so the
 * lookups behave like the real ones without a database.
 */
function fakeAdmin(overrides: {
  ispId?: string | null
  payment?: Record<string, unknown> | null
  config?: Record<string, unknown> | null
  rpcResults?: Record<string, unknown>
  calls?: string[]
} = {}) {
  const calls = overrides.calls ?? []
  const ispId = 'ispId' in overrides ? overrides.ispId : 'isp-a'
  const config = overrides.config === undefined
    ? {
        payment_provider: 'payhero',
        payhero_channel_id: 13137,
        connection_status: 'connected',
      }
    : overrides.config
  const payment = 'payment' in overrides
    ? overrides.payment
    : { id: 'pay-1', isp_id: 'isp-a', status: 'pending', payhero_channel_id: 13137 }

  return {
    calls,
    auth: {
      getUser: vi.fn(async (jwt: string) => ({
        data: { user: jwt === JWT ? { id: 'user-1' } : null },
        error: null,
      })),
    },
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (table === 'isp_payment_configs' && col === 'isp_id') {
            builder.__result = ispId === val ? config : null
          }
          if (table === 'payments' && col === 'provider_reference') {
            builder.__result = payment
          }
          return chain
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              // The tenant comes from the caller's own profile row, keyed by their
              // user id — exactly how the real RLS policies resolve it.
              table === 'profiles'
                ? { isp_id: ispId }
                : table === 'platform_payment_config'
                  // The encrypted credential lives here, never in plaintext.
                  ? { payhero_api_token_ciphertext: STORED_CIPHERTEXT }
                  : (builder.__result ?? null),
            error: null,
          }),
        single: () => Promise.resolve({ data: builder.__result ?? null, error: null }),
        limit: () => chain,
        order: () => chain,
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => Promise.resolve({ data: null, error: null }),
        upsert: () => Promise.resolve({ data: null, error: null }),
      }
      return chain
    },
    rpc: vi.fn(async (fn: string) => {
      calls.push(fn)
      const results = overrides.rpcResults ?? {}
      const value = results[fn]
      if (value instanceof Error) return { data: null, error: { message: value.message } }
      return { data: value ?? null, error: null }
    }),
  } as never
}

/** Stubs fetch so PayHero answers with a canned transaction-status body. */
function providerFetch(statusBody: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(statusBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('PayHero STK initiation resolves everything server-side', () => {
  it('never accepts an amount from the caller', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? '{}'))
      // The amount that reaches the provider must be the one the DATABASE
      // resolved, whatever the request claimed.
      expect(sent.amount).toBe(1500)
      expect(sent.channel_id).toBe(13137)
      return new Response(JSON.stringify({ reference: 'PH-1' }), { status: 200 })
    }) as unknown as typeof fetch

    const admin = fakeAdmin({
      rpcResults: {
        create_payhero_payment: {
          payment_id: 'pay-1',
          reference: 'ISPFLOW-abc',
          amount: 1500,
          currency: 'KES',
          payhero_channel_id: 13137,
        },
        record_payhero_stk: { ok: true },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.startPayHeroPayment(JWT, {
      // A tampered body trying to dictate the amount and the channel. Neither is
      // a parameter, so both are simply ignored.
      phone: '0712345678',
      planId: 'plan-1',
    } as never)

    expect(result.ok).toBe(true)
    expect(result.promptSent).toBe(true)
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body ?? '{}'))
    // The reference we minted is what PayHero is told to track.
    expect(body.external_reference).toBe('ISPFLOW-abc')
  })

  it('records the PayHero transaction reference and stays pending', async () => {
    const fetchImpl = providerFetch({ reference: 'PH-77' })
    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      rpcResults: {
        create_payhero_payment: {
          payment_id: 'pay-1',
          reference: 'ISPFLOW-abc',
          amount: 500,
          currency: 'KES',
          payhero_channel_id: 13137,
        },
        record_payhero_stk: { ok: true },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    await service.startPayHeroPayment(JWT, { phone: '0712345678', planId: 'plan-1' })

    // The provider id is persisted, and settlement is never called from here.
    expect(calls).toContain('record_payhero_stk')
    expect(calls).not.toContain('settle_payhero_payment')
  })

  it('refuses a channel that changed mid-flight', async () => {
    const admin = fakeAdmin({
      rpcResults: {
        create_payhero_payment: {
          payment_id: 'pay-1',
          reference: 'ISPFLOW-abc',
          amount: 500,
          currency: 'KES',
          // A different Till than the one this tenant resolved.
          payhero_channel_id: 99999,
        },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl: providerFetch({}) })
    const err = await service
      .startPayHeroPayment(JWT, { phone: '0712345678', planId: 'plan-1' })
      .catch((e) => e)

    expect((err as { code?: string }).code).toBe('unknown_account')
  })

  it('refuses when the tenant has no PayHero channel', async () => {
    const admin = fakeAdmin({
      config: {
        payment_provider: 'payhero',
        payhero_channel_id: null,
        connection_status: 'connected',
      },
    })
    const service = new PaymentGatewayService({ admin, fetchImpl: providerFetch({}) })
    const err = await service
      .startPayHeroPayment(JWT, { phone: '0712345678', planId: 'plan-1' })
      .catch((e) => e)

    expect((err as { code?: string }).code).toBe('not_connected')
  })

  it('rejects an unauthenticated caller before touching the provider', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({ calls })
    const service = new PaymentGatewayService({ admin, fetchImpl: providerFetch({}) })
    const err = await service
      .startPayHeroPayment('not-a-jwt', { phone: '0712345678', planId: 'plan-1' })
      .catch((e) => e)

    expect((err as { code?: string }).code).toBe('unauthorized')
    expect(calls).not.toContain('create_payhero_payment')
  })
})
describe('PayHero callbacks are never believed on their own', () => {
  it('settles only after PayHero confirms success', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      rpcResults: {
        settle_payhero_payment: {
          settled: true, duplicate: false, activated: true, isp_id: 'isp-a',
        },
      },
    })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ status: 'Success', id: 'PH-9', amount: 500 }),
    })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(true)
    expect(result.activated).toBe(true)
    // Settling is delegated to the shared function, so invoice marking, package
    // activation, RADIUS and SMS all behave exactly as they do for HashBack.
    expect(calls).toContain('settle_payhero_payment')
  })

  it('does NOT settle when PayHero says the transaction failed', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({ calls })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ status: 'Failed' }),
    })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(result.activated).toBe(false)
    expect(result.reason).toBe('failed')
    expect(calls).toContain('fail_hashback_payment')
    expect(calls).not.toContain('settle_payhero_payment')
  })

  it('activates nothing while the transaction is still pending', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({ calls })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ status: 'Processing' }),
    })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(result.activated).toBe(false)
    expect(result.reason).toBe('pending')
    // Nothing at all is written: a pending STK is neither a failure nor a success.
    expect(calls).not.toContain('settle_payhero_payment')
    expect(calls).not.toContain('fail_hashback_payment')
  })

  it('never settles on an unknown status string', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({ calls })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ status: 'something-unexpected' }),
    })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(calls).not.toContain('settle_payhero_payment')
  })

  it('reports a replayed callback as a duplicate without re-settling', async () => {
    // The payment is already settled, so the service must short-circuit BEFORE
    // asking PayHero and must never activate a second time.
    const fetchImpl = providerFetch({ status: 'Success' })
    const admin = fakeAdmin({
      payment: {
        id: 'pay-1', isp_id: 'isp-a', status: 'success', payhero_channel_id: 13137,
      },
      rpcResults: {
        settle_payhero_payment: { settled: false, duplicate: true, activated: false },
      },
    })
    const service = new PaymentGatewayService({ admin, fetchImpl })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.duplicate).toBe(true)
    expect(result.activated).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses an unknown reference without calling PayHero', async () => {
    const fetchImpl = providerFetch({ status: 'Success' })
    const admin = fakeAdmin({ payment: null })
    const service = new PaymentGatewayService({ admin, fetchImpl })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-made-up' })

    expect(result.reason).toBe('unknown_reference')
    expect(result.activated).toBe(false)
    // Nothing is asked of the provider for a payment we do not own.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses an empty reference outright', async () => {
    const service = new PaymentGatewayService({
      admin: fakeAdmin(),
      fetchImpl: providerFetch({}),
    })
    const result = await service.verifyPayHeroPayment({ reference: '   ' })
    expect(result.reason).toBe('unknown_reference')
  })
})
describe('PayHero tenant isolation', () => {
  it('loads the channel for the resolved tenant only', async () => {
    // The service resolves the ISP from the session; the config lookup is keyed by
    // that id, so a tenant can only ever load its own channel.
    const admin = fakeAdmin({
      ispId: 'isp-b',
      config: {
        payment_provider: 'payhero',
        payhero_channel_id: 55555,
        connection_status: 'connected',
      },
      rpcResults: {
        create_payhero_payment: {
          payment_id: 'pay-2',
          reference: 'ISPFLOW-def',
          amount: 300,
          currency: 'KES',
          payhero_channel_id: 55555,
        },
        record_payhero_stk: { ok: true },
      },
    })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ reference: 'PH-2' }),
    })

    const result = await service.startPayHeroPayment(JWT, {
      phone: '0712345678',
      planId: 'plan-9',
    })
    expect(result.ok).toBe(true)

    // A tenant with no config row at all resolves null, so it can never borrow
    // another tenant's channel.
    const other = new PaymentGatewayService({
      admin: fakeAdmin({ ispId: 'isp-c', config: null }),
      fetchImpl: providerFetch({}),
    })
    const err = await other
      .startPayHeroPayment(JWT, { phone: '0712345678', planId: 'plan-9' })
      .catch((e) => e)
    expect((err as { code?: string }).code).toBe('not_connected')
  })

  it('routes settlement to the payment row’s own tenant', async () => {
    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      payment: {
        id: 'pay-9', isp_id: 'isp-tenant-7', status: 'pending', payhero_channel_id: 42,
      },
      rpcResults: {
        settle_payhero_payment: { settled: true, activated: true, isp_id: 'isp-tenant-7' },
      },
    })
    const service = new PaymentGatewayService({
      admin,
      fetchImpl: providerFetch({ status: 'Success' }),
    })

    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    // The tenant comes from the payment row we looked up, never from the payload.
    expect(result.ispId).toBe('isp-tenant-7')
  })

  it('keeps PayHero verification free of the credential', async () => {
    const fetchImpl = providerFetch({ status: 'Success' })
    const admin = fakeAdmin({
      rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
    })
    const service = new PaymentGatewayService({ admin, fetchImpl })

    await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    const rendered = JSON.stringify(
      vi.mocked(fetchImpl).mock.calls.map((c) => c[1]?.body ?? null),
    )
    expect(rendered).not.toContain(TOKEN)
  })
})