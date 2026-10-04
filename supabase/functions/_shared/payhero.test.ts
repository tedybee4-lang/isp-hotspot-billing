/**
 * PayHero provider client tests.
 *
 * Every PayHero response here is mocked. Nothing in this file contacts PayHero,
 * and no test records a real or simulated payment anywhere — these assert on the
 * adapter's own behaviour only.
 *
 * The cases that matter most are the ones where being wrong costs money or leaks
 * a secret: an STK initiation mistaken for a payment, an absent reference treated
 * as accepted, and the Basic credential appearing in an error.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PayHeroClient,
  HashBackError,
  PAYHERO_BASE_URL,
  PAYHERO_ENDPOINTS,
} from './payhero.ts'

const TOKEN = 'test-basic-token-not-a-real-credential'
const BASE = 'https://backend.payhero.co.ke/'

/** Builds a fetch stub that records calls and returns a canned response. */
function stubFetch(response: {
  status?: number
  body?: unknown
  rawBody?: string
}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(response.rawBody ?? JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function client(response: Parameters<typeof stubFetch>[0], opts = {}) {
  const { impl, calls } = stubFetch(response)
  return {
    calls,
    api: new PayHeroClient({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: impl, ...opts }),
  }
}

const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body ?? '{}'))
const header = (call: { init: RequestInit }, name: string) =>
  new Headers(call.init.headers).get(name)
describe('PayHero endpoint and auth contract', () => {
  it('targets the documented base URL, not the frontend host', () => {
    // The docs site is a frontend; the API lives on a different host. Confusing
    // the two is a silent outage, so it is pinned here.
    expect(PAYHERO_BASE_URL).toBe('https://backend.payhero.co.ke')
  })

  it('uses the v2 paths PayHero documents', () => {
    expect(PAYHERO_ENDPOINTS).toEqual({
      initiateStk: '/api/v2/payments',
      paymentChannels: '/api/v2/payment_channels',
      wallets: '/api/v2/wallets',
      transactionStatus: '/api/v2/transaction-status',
      // Used to recover a payment whose callback never arrived.
      accountTransactions: '/api/v2/transactions',
    })
  })

  it('sends the credential as a Basic auth header on every request', async () => {
    const { api, calls } = client({ body: { payment_channels: [] } })
    await api.listChannels()
    expect(header(calls[0], 'Authorization')).toBe(`Basic ${TOKEN}`)
  })

  it('strips a trailing slash from a configured base URL', async () => {
    const { impl, calls } = stubFetch({ body: { payment_channels: [] } })
    await new PayHeroClient({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: impl }).listChannels()
    // A doubled slash would 404 against a host that only answers exact paths.
    expect(calls[0].url).toBe('https://backend.payhero.co.ke/api/v2/payment_channels')
  })
})

describe('PayHero STK initiation', () => {
  it('sends the documented payload with the caller-resolved amount and channel', async () => {
    const { api, calls } = client({ body: { reference: 'PH-1' } })
    await api.initiateStk({
      channelId: 13137,
      amount: 150,
      phoneNumber: '0712345678',
      externalReference: 'ISPFLOW-INV-1',
      customerName: 'Ada',
    })
    expect(body(calls[0])).toEqual({
      amount: 150,
      phone_number: '254712345678',
      channel_id: 13137,
      provider: 'm-pesa',
      external_reference: 'ISPFLOW-INV-1',
      customer_name: 'Ada',
    })
  })

  it('omits optional fields rather than sending empty strings', async () => {
    const { api, calls } = client({ body: { reference: 'PH-2' } })
    await api.initiateStk({
      channelId: 13137,
      amount: 100,
      phoneNumber: '0712345678',
      externalReference: 'INV-2',
    })
    const sent = body(calls[0])
    expect('customer_name' in sent).toBe(false)
    expect('callback_url' in sent).toBe(false)
  })

  it('treats an absent reference as NOT accepted', async () => {
    // PayHero has no boolean success flag, so the reference IS the signal. A 200
    // carrying no reference must not be read as a live prompt, or the customer
    // would see a pending payment that no money is behind.
    const { api } = client({ status: 200, body: { status: 'failed' } })
    const result = await api.initiateStk({
      channelId: 13137,
      amount: 100,
      phoneNumber: '0712345678',
      externalReference: 'INV-3',
    })
    expect(result.accepted).toBe(false)
    expect(result.reference).toBeNull()
  })

  it('reports acceptance when a reference comes back', async () => {
    const { api } = client({ body: { reference: 'PH-4' } })
    const result = await api.initiateStk({
      channelId: 13137,
      amount: 100,
      phoneNumber: '0712345678',
      externalReference: 'INV-4',
    })
    expect(result.accepted).toBe(true)
    expect(result.reference).toBe('PH-4')
  })

  it('refuses to send a non-positive amount', async () => {
    for (const amount of [0, -100, NaN, Infinity]) {
      const { api } = client({ body: { reference: 'never' } })
      const err = await api
        .initiateStk({
          channelId: 13137,
          amount,
          phoneNumber: '0712345678',
          externalReference: 'INV-5',
        })
        .catch((e) => e)
      expect(err, String(amount)).toBeInstanceOf(HashBackError)
      expect((err as HashBackError).kind).toBe('validation')
    }
  })

  it('refuses to send an invalid Kenyan phone number', async () => {
    const { api } = client({ body: { reference: 'never' } })
    const err = await api
      .initiateStk({
        channelId: 13137,
        amount: 100,
        phoneNumber: '12345',
        externalReference: 'INV-6',
      })
      .catch((e) => e)
    expect((err as HashBackError).kind).toBe('validation')
  })

  it('refuses a channel id that is not a real channel', async () => {
    // channel_id 0 would silently push to an undefined destination.
    const { api } = client({ body: { reference: 'never' } })
    const err = await api
      .initiateStk({
        channelId: 0,
        amount: 100,
        phoneNumber: '0712345678',
        externalReference: 'INV-7',
      })
      .catch((e) => e)
    expect((err as HashBackError).kind).toBe('validation')
  })
})
describe('PayHero transaction verification', () => {
  it('reads a settled success', async () => {
    const { api } = client({ body: { status: 'Success' } })
    expect((await api.getTransactionStatus('PH-1')).state).toBe('success')
  })

  it('reads a failure', async () => {
    const { api } = client({ body: { status: 'Failed' } })
    expect((await api.getTransactionStatus('PH-2')).state).toBe('failed')
  })

  it('treats an unrecognised status as pending, never as success', async () => {
    // The safe default matters: an unknown status must not activate service.
    const { api } = client({ body: {} })
    expect((await api.getTransactionStatus('PH-3')).state).toBe('pending')
  })

  it('encodes the reference so it cannot break out of the query string', async () => {
    const { api, calls } = client({ body: { status: 'Success' } })
    await api.getTransactionStatus('a&reference=injected')
    expect(calls[0].url).toContain('reference=a%26reference%3Dinjected')
  })
})

describe('PayHero discovery', () => {
  const channels = {
    payment_channels: [
      {
        id: 13137,
        channel_type: 'till',
        transaction_type: 'CustomerBuyGoodsOnline',
        account_id: 10052,
        short_code: '5441898',
        account_number: '',
        description: '',
        is_active: true,
      },
    ],
  }

  it('returns the channels registered on the account', async () => {
    const { api } = client({ body: channels })
    expect(await api.listChannels()).toHaveLength(1)
  })

  it('returns an empty list when the account has no channels', async () => {
    const { api } = client({ body: {} })
    expect(await api.listChannels()).toEqual([])
  })

  it('reports account, balance and channels from one inspect pass', async () => {
    const impl = vi.fn(async (url: string | URL | Request) => {
      const payload = String(url).includes('payment_channels')
        ? channels
        : {
            id: 11590,
            account_id: 10052,
            wallet_type: 'service_wallet',
            currency: 'KES',
            available_balance: 28.5,
            wallet_status: 'PENDING',
          }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const api = new PayHeroClient({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: impl as unknown as typeof fetch,
    })
    const result = await api.inspect()
    expect(result.accountId).toBe(10052)
    expect(result.balance).toBe(28.5)
    expect(result.currency).toBe('KES')
    expect(result.channels[0].short_code).toBe('5441898')
    expect(result.apiReachable).toBe(true)
  })
})
describe('PayHero error handling and secret protection', () => {
  it('classifies 401 and 403 as auth failures, which retries cannot fix', async () => {
    for (const status of [401, 403]) {
      const { api } = client({ status, body: { error_message: 'nope' } })
      const err = await api.listChannels().catch((e) => e)
      expect((err as HashBackError).kind, String(status)).toBe('auth')
    }
  })

  it('separates rate limits, server faults and rejections', async () => {
    const cases: Array<[number, string]> = [
      [429, 'rate_limit'],
      [500, 'provider'],
      [400, 'rejection'],
    ]
    for (const [status, kind] of cases) {
      const { api } = client({ status, body: { error_message: 'x' } })
      const err = await api.listChannels().catch((e) => e)
      expect((err as HashBackError).kind, String(status)).toBe(kind)
    }
  })

  it('never leaks the credential into a thrown error', async () => {
    // An auth failure is the likeliest time to leak, by building a message that
    // embeds the request. The token must not appear in anything thrown.
    const { api } = client({ status: 401, body: { error_message: 'Invalid credentials' } })
    const err = await api.listChannels().catch((e) => e)
    const rendered = `${(err as Error).name} ${(err as Error).message} ${
      (err as HashBackError).providerMessage ?? ''
    } ${JSON.stringify((err as HashBackError).details ?? null)}`
    expect(rendered).not.toContain(TOKEN)
  })

  it('reports a non-JSON response as malformed instead of crashing', async () => {
    const { api } = client({ rawBody: '<html>gateway</html>' })
    const err = await api.listChannels().catch((e) => e)
    expect((err as HashBackError).kind).toBe('malformed')
  })

  it('reports an unreachable provider as a network error', async () => {
    const impl = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const api = new PayHeroClient({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: impl as unknown as typeof fetch,
    })
    const err = await api.listChannels().catch((e) => e)
    expect((err as HashBackError).kind).toBe('network')
  })

  it('keeps provider-authored detail for the operator to read', async () => {
    const { api } = client({ status: 400, body: { error_message: 'Channel not active' } })
    const err = await api.listChannels().catch((e) => e)
    expect((err as HashBackError).providerMessage).toBe('Channel not active')
    expect((err as HashBackError).status).toBe(400)
  })
})

describe('Register Payment Channel', () => {
  // This is the operation that turns a new ISP's Till into a channel they can
  // actually take money against, so both its request shape and its refusal to
  // fake success are pinned here.

  it('posts the documented body to the documented path', async () => {
    // Field names are PayHero's own, verbatim from its Register Payment Channel
    // documentation. Inventing one would be a silent 400 against the live API.
    const { api, calls } = client({
      body: { id: 2429, channel_type: 'till', account_id: 5003, short_code: '522533' },
    })

    const result = await api.registerChannel({
      channelType: 'till',
      accountId: 5003,
      shortCode: '522533',
      accountNumber: '522533',
      description: 'Beta Broadband',
    })

    expect(calls[0].url).toBe(`${BASE}api/v2/payment_channels`)
    expect(calls[0].init.method).toBe('POST')
    expect(body(calls[0])).toEqual({
      channel_type: 'till',
      account_id: 5003,
      short_code: 522533,
      account_number: '522533',
      description: 'Beta Broadband',
    })
    expect(result.registered).toBe(true)
    expect(result.channel?.id).toBe(2429)
  })

  it('treats a 200 with no channel id as a FAILURE, not a quiet success', async () => {
    // Marking a channel ready that PayHero did not create is the worst outcome:
    // the dashboard says live and every customer's STK push is then rejected.
    const { api } = client({ body: { status: 'ok' } })
    const result = await api.registerChannel({
      channelType: 'till', accountId: 5003, shortCode: '522533',
      accountNumber: '522533', description: 'X',
    })
    expect(result.registered).toBe(false)
    expect(result.channel).toBeNull()
  })

  it('refuses a malformed Till before spending a provider call', async () => {
    // PayHero would reject this anyway, but failing locally means a typo cannot
    // create a junk channel on a real merchant account.
    const { api, calls } = client({ body: { id: 1 } })
    await expect(api.registerChannel({
      channelType: 'till', accountId: 5003, shortCode: 'abc',
      accountNumber: 'abc', description: 'X',
    })).rejects.toMatchObject({ kind: 'validation' })
    expect(calls).toHaveLength(0)
  })

  it('finds an existing channel by short code instead of creating a duplicate', async () => {
    // PayHero's register endpoint has NO idempotency key, so this lookup is the
    // only thing standing between an ISP and two channels for one Till.
    const { impl, calls } = stubFetch({
      body: {
        payment_channels: [
          { id: 1, short_code: '111111' },
          { id: 13137, short_code: '5441898' },
        ],
      },
    })
    const api = new PayHeroClient({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: impl })

    const found = await api.findChannelByShortCode('5441898')
    expect(found?.id).toBe(13137)
    // Only the discovery GET. No POST: nothing was created.
    expect(calls).toHaveLength(1)
  })

  it('returns null when PayHero knows no channel for that Till', async () => {
    const { impl } = stubFetch({ body: { payment_channels: [] } })
    const api = new PayHeroClient({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: impl })
    expect(await api.findChannelByShortCode('999999')).toBeNull()
  })
})

describe('transaction-status identifiers', () => {
  it('reads the M-Pesa receipt out of the status response', async () => {
    // The documented response names the M-Pesa code `third_party_reference`. Before
    // this, settlement stored OUR reference as the receipt, so the ISP list showed
    // an internal id where the customer could see their real M-Pesa code.
    const { api } = client({
      body: {
        status: 'SUCCESS',
        reference: 'feb7-4ad8-99f0',
        third_party_reference: 'SKQ96C7K7H',
        amount: 10,
      },
    })
    const status = await api.getTransactionStatus('feb7-4ad8-99f0')
    expect(status.receipt).toBe('SKQ96C7K7H')
    expect(status.providerReference).toBe('feb7-4ad8-99f0')
    expect(status.amount).toBe(10)
    expect(status.state).toBe('success')
  })

  it('does NOT treat QUEUED as success', async () => {
    // PayHero documents QUEUED as "no callback received yet". Reading it as paid
    // would grant service for money that has not moved.
    const { api } = client({ body: { status: 'QUEUED' } })
    expect((await api.getTransactionStatus('x')).state).toBe('pending')
  })
})