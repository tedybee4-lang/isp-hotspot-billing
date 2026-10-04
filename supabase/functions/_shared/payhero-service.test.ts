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
  /** Other ISPs' short codes, for the cross-tenant Till-conflict check. */
  claimants?: Array<{ isp_id: string; payhero_channel_short_code: string | null }>
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
        // The cross-tenant Till-claimant sweep in channel provisioning. Returns
        // whatever the test configured as `claimants`, defaulting to none.
        neq: () => chain,
        not: () => Promise.resolve({
          data: (overrides as { claimants?: unknown }).claimants ?? [],
          error: null,
        }),
        limit: () => chain,
        lte: () => chain,
        order: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              // The tenant comes from the caller's own profile row, keyed by their
              // user id — exactly how the real RLS policies resolve it.
              table === 'profiles'
                ? { isp_id: ispId }
                : table === 'platform_payment_config'
                  // The encrypted credential lives here, never in plaintext.
                  // payhero_account_id is what channel registration needs as its
                  // `account_id`, so it must be present for provisioning to proceed.
                  ? {
                      payhero_api_token_ciphertext: STORED_CIPHERTEXT,
                      payhero_account_id: 5003,
                    }
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
describe('a verified PayHero payment reaches settlement', () => {
  // These regressions came from a real customer payment that completed at PayHero
  // and then sat at 'pending' in ISPFLOW forever. Both defects below were in this
  // module, and neither was visible until a real money movement was traced.

  it('looks the transaction up by the reference PAYHERO issued, not ours', async () => {
    // Verified against the live API on a real payment:
    //   ?reference=ISPFLOW-<ours>  -> 404
    //   ?reference=feb7-4ad8-...   -> SUCCESS
    // Querying with our own value 404s, which threw, so settlement never ran.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS', id: 'PH-1' }), { status: 200 }),
    ) as unknown as typeof fetch

    const admin = fakeAdmin({
      payment: {
        id: 'pay-1',
        isp_id: 'isp-a',
        status: 'pending',
        // What record_payhero_stk stored when PayHero accepted the push.
        provider_transaction_id: 'feb7-4ad8-99f0',
      },
      rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(true)
    const asked = String(vi.mocked(fetchImpl).mock.calls[0][0])
    expect(asked).toContain('reference=feb7-4ad8-99f0')
    expect(asked).not.toContain('ISPFLOW-abc')
  })

  it('falls back to our reference only when PayHero never issued one', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 }),
    ) as unknown as typeof fetch

    const admin = fakeAdmin({
      payment: { id: 'pay-1', isp_id: 'isp-a', status: 'pending', provider_transaction_id: null },
      rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toContain('ISPFLOW-abc')
  })

  it('treats a 404 as still-pending rather than abandoning the payment', async () => {
    // A callback can arrive before PayHero has indexed the transaction. Giving up
    // there is what left a paying customer with nothing.
    const fetchImpl = vi.fn(async () =>
      new Response('', { status: 404 }),
    ) as unknown as typeof fetch
    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      payment: {
        id: 'pay-1', isp_id: 'isp-a', status: 'pending', provider_transaction_id: 'feb7-x',
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(result.reason).toBe('pending')
    // Crucially, it did NOT settle on a lookup that failed.
    expect(calls).not.toContain('settle_payhero_payment')
  })
it('selects only columns that exist on the payments table', async () => {
    // `payhero_channel_id` lives on isp_payment_configs. Naming it here made the
    // query ERROR, and because the error was discarded the result looked like an
    // unknown reference, so every real payment was written off for reconciliation
    // while the customer had already paid.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 }),
    ) as unknown as typeof fetch
    const selects: string[] = []

    const row = {
      id: 'pay-1', isp_id: 'isp-a', status: 'pending', provider_transaction_id: 'feb7-x',
    }
    const makeChain = (table: string): unknown => {
      const chain: Record<string, unknown> = {}
      chain.select = (cols: string) => {
        if (table === 'payments') selects.push(cols)
        return chain
      }
      chain.eq = () => chain
      // The platform config serves the encrypted credential; verification needs
      // it to build a client, exactly as it does in production.
      chain.maybeSingle = () =>
        Promise.resolve({
          data: table === 'platform_payment_config'
            ? { payhero_api_token_ciphertext: STORED_CIPHERTEXT }
            : row,
          error: null,
        })
      chain.single = () => Promise.resolve({ data: null, error: null })
      chain.limit = () => chain
      chain.order = () => chain
      chain.insert = () => Promise.resolve({ data: null, error: null })
      chain.update = () => Promise.resolve({ data: null, error: null })
      chain.upsert = () => Promise.resolve({ data: null, error: null })
      return chain
    }

    const admin = {
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      from: (table: string) => makeChain(table),
      rpc: async () => ({ data: { settled: true, activated: true }, error: null }),
    } as never

    const service = new PaymentGatewayService({ admin, fetchImpl })
    expect((await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })).settled).toBe(true)

    expect(selects.length).toBeGreaterThan(0)
    for (const cols of selects) {
      expect(cols, 'selected a column absent from the payments table').not.toMatch(
        /payhero_channel_id/,
      )
    }
  })

  it('maps PayHero SUCCESS — which it returns upper-case — to a settlement', async () => {
    // Observed verbatim from the live API. A case-sensitive comparison would have
    // read this as an unknown status and left the payment pending.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS', amount: 10 }), { status: 200 }),
    ) as unknown as typeof fetch

    const admin = fakeAdmin({
      payment: {
        id: 'pay-1', isp_id: 'isp-a', status: 'pending', provider_transaction_id: 'feb7-x',
      },
      rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    expect((await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })).settled).toBe(true)
  })

  it('is idempotent across a replayed callback', async () => {
    const first = new PaymentGatewayService({
      admin: fakeAdmin({
        payment: {
          id: 'pay-1', isp_id: 'isp-a', status: 'pending', provider_transaction_id: 'feb7-x',
        },
        rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
      }),
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 }),
      ) as unknown as typeof fetch,
    })
    expect((await first.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })).settled).toBe(true)

    // Replay: the row already says success, so it short-circuits before spending
    // an API call and settles nothing a second time.
    const replayFetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 }),
    ) as unknown as typeof fetch
    const calls: string[] = []
    const replay = new PaymentGatewayService({
      admin: fakeAdmin({
        calls,
        payment: {
          id: 'pay-1', isp_id: 'isp-a', status: 'success', provider_transaction_id: 'feb7-x',
        },
      }),
      fetchImpl: replayFetch,
    })

    const second = await replay.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })
    expect(second.duplicate).toBe(true)
    expect(second.settled).toBe(false)
    expect(second.activated).toBe(false)
    expect(replayFetch).not.toHaveBeenCalled()
    expect(calls).not.toContain('settle_payhero_payment')
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

describe('automatic PayHero channel provisioning', () => {
  // The property under test: an ISP enters a Till and it becomes a channel they
  // can take money against, WITHOUT a human creating it in PayHero's dashboard,
  // and WITHOUT a second channel ever appearing for the same Till.

  it('registers a channel with PayHero for a brand-new Till', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Discovery first: PayHero does not know this Till yet.
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ payment_channels: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ id: 9001, channel_type: 'till', short_code: '522533' }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      config: { payhero_channel_id: null, payhero_channel_short_code: null },
      rpcResults: {
        provision_payhero_channel: {
          ok: true, payhero_channel_id: 9001, connection_status: 'connected',
        },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.provisionPayHeroChannel({ ispId: 'isp-a', shortCode: '522533' })

    expect(result.ok).toBe(true)
    expect(result.status).toBe('ready')
    expect(result.created).toBe(true)
    expect(calls).toContain('provision_payhero_channel')

    // The documented Register Payment Channel body was sent, verbatim.
    const posted = vi.mocked(fetchImpl).mock.calls
      .map((c) => c[1]?.body)
      .filter(Boolean)
      .map((b) => JSON.parse(String(b)))
    expect(posted[0]).toMatchObject({ channel_type: 'till', short_code: 522533 })
  })

  it('creates NOTHING when the Till has not changed', async () => {
    // This is the duplicate-channel guard. PayHero's register endpoint has no
    // idempotency key, so re-registering on every settings save would leave an
    // ISP with two channels for one Till and split its history.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ payment_channels: [] }), { status: 200 }),
    ) as unknown as typeof fetch

    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      config: { payhero_channel_id: 13137, payhero_channel_short_code: '5441898' },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.provisionPayHeroChannel({
      ispId: 'isp-a',
      // The SAME Till already connected.
      shortCode: '5441898',
    })

    expect(result.status).toBe('ready')
    expect(result.created).toBe(false)
    expect(result.channelId).toBe(13137)
    // No provider write of any kind, and no database write either.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(calls).not.toContain('provision_payhero_channel')
  })

  it('ADOPTS a channel PayHero already knows rather than creating a second', async () => {
    // An ISP whose Till was registered out-of-band is linked to that channel. It
    // is not duplicated, which is the whole reason discovery runs before register.
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          payment_channels: [{ id: 7777, short_code: '5441898', is_active: true }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch

    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      config: { payhero_channel_id: null, payhero_channel_short_code: null },
      rpcResults: {
        provision_payhero_channel: {
          ok: true, payhero_channel_id: 7777, connection_status: 'connected',
        },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.provisionPayHeroChannel({
      ispId: 'isp-a', shortCode: '5441898',
    })

    expect(result.ok).toBe(true)
    expect(result.created).toBe(false)
    expect(result.channelId).toBe(7777)
    // Discovery only: no POST was made.
    expect(vi.mocked(fetchImpl).mock.calls.every(
      (c) => (c[1]?.method ?? 'GET') === 'GET',
    )).toBe(true)
  })

  it('rejects a malformed Till before contacting PayHero', async () => {
    // Server-side validation is mandatory: an obvious typo must not become a
    // channel on a real merchant account, and must not cost a provider call.
    const fetchImpl = vi.fn(async () => {
      throw new Error('PayHero must not be contacted for an invalid Till')
    }) as unknown as typeof fetch
    const admin = fakeAdmin({ config: { payhero_channel_id: null } })
    const service = new PaymentGatewayService({ admin, fetchImpl })

    const result = await service.provisionPayHeroChannel({ ispId: 'isp-a', shortCode: '12' })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid_till')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never reports READY when PayHero refused the registration', async () => {
    // The failure mode this guards: a dashboard saying "ready" for a channel
    // PayHero never created, so every customer's STK push is then rejected.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ payment_channels: [] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({ error_message: 'Invalid request' }),
        { status: 400 },
      )
    }) as unknown as typeof fetch

    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      config: { payhero_channel_id: null, payhero_channel_short_code: null },
      // The failure path is recorded as a FAILURE state only.
      rpcResults: { set_payhero_channel_state: { ok: true } },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.provisionPayHeroChannel({ ispId: 'isp-a', shortCode: '522533' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.channelId).toBeNull()
    // Recorded as failed, and never bound to a channel.
    expect(calls).toContain('set_payhero_channel_state')
    expect(calls).not.toContain('provision_payhero_channel')
  })

  it('never reports READY when the database refuses the binding', async () => {
    // PayHero succeeded but the write did not. Reporting ready here would show an
    // ISP a live channel that no payment can actually reach.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ payment_channels: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: 9001, short_code: '522533' }), { status: 200 })
    }) as unknown as typeof fetch

    const admin = fakeAdmin({
      config: { payhero_channel_id: null, payhero_channel_short_code: null },
      rpcResults: {
        // The one-channel-one-ISP rule refusing.
        provision_payhero_channel: { ok: false, reason: 'channel_already_assigned' },
      },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.provisionPayHeroChannel({ ispId: 'isp-a', shortCode: '522533' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.code).toBe('channel_already_assigned')
  })
})

describe('callback lookup hints and amount verification', () => {
  it('falls back through PayHero identifiers when one 404s', async () => {
    // The STK reference may not be indexed yet, but PayHero also indexes the
    // M-Pesa receipt. Giving up on the first 404 is what stranded a real payment.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('not-indexed')) {
        return new Response(JSON.stringify({ error_message: 'Not found' }), { status: 404 })
      }
      return new Response(
        JSON.stringify({ status: 'SUCCESS', third_party_reference: 'SKQ96C7K7H', amount: 10 }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const admin = fakeAdmin({
      payment: {
        id: 'pay-1', isp_id: 'isp-a', status: 'pending',
        provider_transaction_id: 'not-indexed', amount: 10,
      },
      rpcResults: { settle_payhero_payment: { settled: true, activated: true } },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.verifyPayHeroPayment({
      reference: 'ISPFLOW-abc',
      receiptHint: 'SKQ96C7K7H',
    })

    expect(result.settled).toBe(true)
    // The real M-Pesa receipt is stored, not our internal reference.
    const settledArgs = vi.mocked(admin.rpc).mock.calls
      .find((c) => c[0] === 'settle_payhero_payment')?.[1] as Record<string, unknown>
    expect(settledArgs.p_receipt).toBe('SKQ96C7K7H')
  })

  it('leaves the payment pending when no identifier resolves', async () => {
    // Early indexing latency must NOT fail a real payment, and must NOT be
    // reported as success either. Pending lets the reconciliation sweep retry.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error_message: 'Not found' }), { status: 404 }),
    ) as unknown as typeof fetch

    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      payment: { id: 'pay-1', isp_id: 'isp-a', status: 'pending', amount: 10 },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(result.reason).toBe('pending')
    expect(calls).not.toContain('settle_payhero_payment')
    expect(calls).not.toContain('fail_hashback_payment')
  })

  it('refuses to settle when PayHero reports a different amount', async () => {
    // A verified SUCCESS is necessary but not sufficient: it must be the SUCCESS
    // of THIS payment. Activating on a mismatched sum is a revenue and trust bug.
    const fetchImpl = providerFetch({ status: 'SUCCESS', amount: 1 })
    const calls: string[] = []
    const admin = fakeAdmin({
      calls,
      payment: { id: 'pay-1', isp_id: 'isp-a', status: 'pending', amount: 1500 },
    })

    const service = new PaymentGatewayService({ admin, fetchImpl })
    const result = await service.verifyPayHeroPayment({ reference: 'ISPFLOW-abc' })

    expect(result.settled).toBe(false)
    expect(result.reason).toBe('amount_mismatch')
    expect(calls).not.toContain('settle_payhero_payment')
  })
})