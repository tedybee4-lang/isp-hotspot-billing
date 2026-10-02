/**
 * HashBack provider client tests.
 *
 * Every provider response here is mocked. Nothing in this file contacts
 * HashBack, and no test creates a real or simulated "successful payment" in any
 * database — these assert on the adapter's own behaviour only.
 *
 * The cases that matter most are the ones where being wrong costs money:
 * an STK initiation mistaken for a payment, a timeout that triggers a duplicate
 * customer prompt, and an auth failure reported as a generic error.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HashBackClient,
  HashBackError,
  normaliseMsisdn,
  normaliseAmount,
  buildReference,
  ENDPOINTS,
} from './hashback.ts'

const KEY = 'test-api-key-not-a-real-credential'
const BASE = 'https://api.hashback.co.ke/'

/** Builds a fetch stub that records calls and returns a canned response. */
function stubFetch(response: {
  status?: number
  body?: unknown
  headers?: Record<string, string>
  rawBody?: string
}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const status = response.status ?? 200
    const text = response.rawBody ?? JSON.stringify(response.body ?? {})
    return new Response(text, {
      status,
      headers: { 'Content-Type': 'application/json', ...(response.headers ?? {}) },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function client(response: Parameters<typeof stubFetch>[0], opts = {}) {
  const { impl, calls } = stubFetch(response)
  return {
    calls,
    api: new HashBackClient({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: impl,
      // No real sleeping in tests.
      sleepImpl: async () => {},
      maxReadRetries: 2,
      ...opts,
    }),
  }
}

const body = (call: { init: RequestInit }) => JSON.parse(String(call.init.body ?? '{}'))

describe('normaliseMsisdn', () => {
  it('normalises every documented Kenyan form to 254XXXXXXXX', () => {
    for (const input of ['0712345678', '+254712345678', '254712345678', '0712 345 678', '0712-345-678']) {
      expect(normaliseMsisdn(input), input).toBe('254712345678')
    }
  })

  it('accepts Airtel-prefixed numbers', () => {
    expect(normaliseMsisdn('0112345678')).toBe('254112345678')
  })

  it('rejects anything that is not a Kenyan mobile number', () => {
    // Rejecting here saves a request and, more importantly, stops a malformed
    // number reaching the provider where it would fail anyway.
    for (const bad of ['', '123', '25471234', '25471234567890', '+25471234567a', 'abcdefghij']) {
      expect(normaliseMsisdn(bad), bad).toBeNull()
    }
  })
})

describe('normaliseAmount', () => {
  it('sends whole amounts without decimals', () => {
    expect(normaliseAmount(1)).toBe('1')
    expect(normaliseAmount(100)).toBe('100')
    expect(normaliseAmount(1500)).toBe('1500')
  })

  it('keeps genuine cents', () => {
    expect(normaliseAmount(12.5)).toBe('12.5')
    expect(normaliseAmount(12.55)).toBe('12.55')
  })

  it('rejects zero, negative and non-finite amounts', () => {
    // A zero or negative STK amount must never be sent: it would either be
    // refused by the provider or, worse, accepted as a trivial payment.
    expect(normaliseAmount(0)).toBeNull()
    expect(normaliseAmount(-100)).toBeNull()
    expect(normaliseAmount(NaN)).toBeNull()
    expect(normaliseAmount(Infinity)).toBeNull()
  })
})

describe('buildReference', () => {
  it('produces a stable, opaque reference', () => {
    expect(buildReference('abc-123')).toBe('NETISP-abc-123')
  })

  it('strips characters that could break a URL, header or log line', () => {
    const ref = buildReference('a/b?c=devil\n')
    expect(ref).not.toContain('/')
    expect(ref).not.toContain('?')
    expect(ref).not.toContain('\n')
  })

  it('never contains a credential', () => {
    // A reference is built from a payment id, never from a secret, so the real
    // guarantee is structural: even if a caller passed a credential-shaped
    // string, the result carries only the safe prefix plus its characters —
    // there is no code path that splices in an API key, webhook secret or
    // encryption key. Assert the shape rather than a tautology.
    const ref = buildReference('7c9e6679-7425-40de-944b-e07fc1f90ae7')
    expect(ref).toBe('NETISP-7c9e6679-7425-40de-944b-e07fc1f90ae7')
    // No credential-shaped delimiter can survive the sanitiser.
    expect(ref).not.toMatch(/[_.]/)
  })
})

describe('HashBackClient construction', () => {
  it('refuses to construct without a key', () => {
    // Failing at construction rather than at first request means a
    // misconfigured deployment is obvious immediately.
    expect(() => new HashBackClient({ apiKey: '' })).toThrow(HashBackError)
  })

  it('exposes only documented endpoints', () => {
    // Guards against an invented endpoint slipping in.
    expect(Object.keys(ENDPOINTS).sort()).toEqual([
      'creditsBalance', 'editLinkedAccount', 'initiateStk', 'linkAccount',
      'listLinkedAccounts', 'pullTransaction', 'registerWebhook',
      'transactionStatus',
    ])
  })
})

describe('initiateStk', () => {
  const ok = {
    status: 200,
    body: {
      success: true,
      message: 'STK push initiated successfully',
      checkout_id: 'ws_CO_123',
      MerchantRequestID: 'f718-44d8',
      ResponseCode: '0',
      ResponseDescription: 'Success. Request accepted for processing',
      CustomerMessage: 'Success. Request accepted for processing',
    },
  }

  it('sends the documented fields and returns the provider identifiers', async () => {
    const { api, calls } = client(ok)
    const res = await api.initiateStk({
      accountId: 'HP56', amount: 500, msisdn: '0712345678', reference: 'NETISP-abc',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}initiatestk`)
    expect(calls[0].init.method).toBe('POST')
    expect(body(calls[0])).toEqual({
      api_key: KEY,             // documented body auth
      account_id: 'HP56',
      amount: '500',
      msisdn: '254712345678',   // normalised
      reference: 'NETISP-abc',
    })

    expect(res.accepted).toBe(true)
    expect(res.checkoutId).toBe('ws_CO_123')
    expect(res.merchantRequestId).toBe('f718-44d8')
  })

  it('does NOT report success from a provider refusal', async () => {
    const { api } = client({ status: 200, body: { success: false, message: 'nope' } })
    const res = await api.initiateStk({
      accountId: 'HP56', amount: 500, msisdn: '0712345678', reference: 'NETISP-abc',
    })
    // The critical distinction: accepted=false must never be read as paid.
    expect(res.accepted).toBe(false)
  })

  it('rejects an invalid phone before spending a request', async () => {
    const { api, calls } = client(ok)
    await expect(api.initiateStk({
      accountId: 'HP56', amount: 500, msisdn: '123', reference: 'NETISP-abc',
    })).rejects.toMatchObject({ kind: 'validation' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-positive amount before spending a request', async () => {
    const { api, calls } = client(ok)
    await expect(api.initiateStk({
      accountId: 'HP56', amount: 0, msisdn: '0712345678', reference: 'NETISP-abc',
    })).rejects.toMatchObject({ kind: 'validation' })
    expect(calls).toHaveLength(0)
  })

  it('never retries on a timeout, to avoid a duplicate customer prompt', async () => {
    const impl = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {},
    })
    await expect(api.initiateStk({
      accountId: 'HP56', amount: 500, msisdn: '0712345678', reference: 'NETISP-abc',
    })).rejects.toMatchObject({ kind: 'timeout' })

    // Exactly one attempt. A second STK push could prompt the same customer twice.
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('never retries a network failure on a money-moving call', async () => {
    const impl = vi.fn(async () => { throw new TypeError('network down') })
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {},
    })
    await expect(api.initiateStk({
      accountId: 'HP56', amount: 500, msisdn: '0712345678', reference: 'NETISP-abc',
    })).rejects.toMatchObject({ kind: 'network' })
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

describe('error mapping', () => {
  const initiate = (api: HashBackClient) => api.initiateStk({
    accountId: 'HP56', amount: 500, msisdn: '0712345678', reference: 'NETISP-abc',
  })

  it('maps 401 to an auth error, so the UI can say "wrong key"', async () => {
    const { api } = client({ status: 401, body: { message: 'Invalid API key' } })
    const err = await initiate(api).catch((e) => e)
    expect(isHashBackErrorLike(err)).toBe(true)
    expect(err.kind).toBe('auth')
    // A wrong key is not retryable; retrying only hides a configuration error.
    expect(err.retryable).toBe(false)
  })

  it('maps 403 to an auth error too', async () => {
    const { api } = client({ status: 403, body: { message: 'Forbidden' } })
    expect((await initiate(api).catch((e) => e)).kind).toBe('auth')
  })

  it('maps 429 to a rate-limit error and reads Retry-After', async () => {
    const { api } = client({
      status: 429,
      body: { error: { code: 429, message: 'Too many requests.' } },
      headers: { 'Retry-After': '7' },
    })
    const err = await initiate(api).catch((e) => e)
    expect(err.kind).toBe('rate_limit')
    expect(err.retryAfterMs).toBe(7000)
  })

  it('caps an absurd Retry-After rather than obeying it literally', async () => {
    const { api } = client({ status: 429, body: {}, headers: { 'Retry-After': '99999' } })
    // A provider (or a misconfiguration) must not be able to pin the worker
    // for a day.
    expect((await initiate(api).catch((e) => e)).retryAfterMs).toBe(60_000)
  })

  it('maps 400 to a validation error, not a generic failure', async () => {
    const { api } = client({
      status: 400,
      body: { ResultCode: '400', message: 'Invalid till number', code: '4001' },
    })
    const err = await initiate(api).catch((e) => e)
    expect(err.kind).toBe('validation')
    // The provider's own wording is preserved so an operator can act on it.
    expect(err.providerMessage).toBe('Invalid till number')
  })

  it('maps 500 to a temporary provider error', async () => {
    const { api } = client({ status: 503, body: { message: 'upstream down' } })
    const err = await initiate(api).catch((e) => e)
    expect(err.kind).toBe('provider')
    expect(err.status).toBe(503)
  })

  it('never leaks the API key into an error', async () => {
    const { api } = client({ status: 500, body: { message: 'boom' } })
    const err = await initiate(api).catch((e) => e)
    const serialised = `${err.message} ${JSON.stringify(err.details)} ${err.providerMessage}`
    expect(serialised).not.toContain(KEY)
  })

  it('reports a malformed body rather than coercing it', async () => {
    const { api } = client({ status: 200, rawBody: '<html>gateway error</html>' })
    // Inventing a plausible result from an HTML error page is how a payment
    // gets marked successful without money moving.
    expect((await initiate(api).catch((e) => e)).kind).toBe('malformed')
  })

  it('reports an empty 200 body as malformed, not as success', async () => {
    const { api } = client({ status: 200, rawBody: '' })
    expect((await initiate(api).catch((e) => e)).kind).toBe('malformed')
  })

  it('reports a JSON array body as malformed', async () => {
    const { api } = client({ status: 200, rawBody: '[1,2,3]' })
    expect((await initiate(api).catch((e) => e)).kind).toBe('malformed')
  })
})

/** Local helper so the test file does not depend on the class identity. */
function isHashBackErrorLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'HashBackError'
}

describe('read operations retry transient failures', () => {
  it('retries a 5xx on a read and then succeeds', async () => {
    let attempt = 0
    const impl = vi.fn(async () => {
      attempt += 1
      if (attempt < 3) return new Response('{"message":"flaky"}', { status: 503 })
      return new Response(JSON.stringify({
        ResponseCode: '0', ResponseDescription: 'accepted',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {}, maxReadRetries: 2,
    })
    const res = await api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_1' })
    expect(attempt).toBe(3)
    expect(res.state).toBe('pending')
  })

  it('gives up after the bounded number of retries', async () => {
    const impl = vi.fn(async () => new Response('{"message":"down"}', { status: 503 }))
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {}, maxReadRetries: 2,
    })
    await expect(
      api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_1' }),
    ).rejects.toMatchObject({ kind: 'provider' })
    // Bounded: 1 initial attempt + 2 retries, never an unbounded loop.
    expect(impl).toHaveBeenCalledTimes(3)
  })

  it('does not retry an auth failure on a read', async () => {
    // Retrying a wrong key three times only slows the operator's fix.
    const impl = vi.fn(async () => new Response('{"message":"bad key"}', { status: 401 }))
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {}, maxReadRetries: 2,
    })
    await expect(
      api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_1' }),
    ).rejects.toMatchObject({ kind: 'auth' })
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

describe('getTransactionStatus', () => {
  it('sends the documented checkoutid field', async () => {
    const { api, calls } = client({ status: 200, body: {
      ResponseCode: '0', ResponseDescription: 'The service request has been accepted successfully',
      ResultCode: '0', ResultDesc: 'The service request is processed successfully.',
    } })
    await api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_123' })
    expect(calls[0].url).toBe(`${BASE}transactionstatus`)
    expect(body(calls[0])).toEqual({
      api_key: KEY, account_id: 'HP56', checkoutid: 'ws_CO_123',
    })
  })

  it('treats an acknowledgement as pending, never as success', async () => {
    // "0" here only means accepted-for-processing. Settling on it would mark a
    // payment paid before the customer entered a PIN.
    const { api } = client({ status: 200, body: { ResponseCode: '0', ResultCode: '0' } })
    const res = await api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_1' })
    expect(res.state).toBe('pending')
  })

  it('reports an explicit non-zero result code as failed', async () => {
    const { api } = client({ status: 200, body: { ResultCode: '1037', ResultDesc: 'Cancelled' } })
    const res = await api.getTransactionStatus({ accountId: 'HP56', checkoutId: 'ws_CO_1' })
    expect(res.state).toBe('failed')
  })
})

describe('pullTransaction (PULL API)', () => {
  it('returns the reconciliation fields from a found transaction', async () => {
    const { api, calls } = client({ status: 200, body: {
      success: true,
      data: { transactionId: 'TRANS_ID', amount: 499, billreference: 'BILL_REF', AccName: 'X' },
    } })
    const res = await api.pullTransaction({ accountId: 'HP56', transactionId: 'TRANS_ID' })
    expect(calls[0].url).toBe(`${BASE}v1/pullapi`)
    expect(body(calls[0])).toEqual({
      api_key: KEY, account_id: 'HP56', transaction_id: 'TRANS_ID',
    })
    expect(res).toMatchObject({
      found: true, amount: 499, billReference: 'BILL_REF', transactionId: 'TRANS_ID',
    })
  })

  it('reports not-found from a 200 body without throwing', async () => {
    const { api } = client({ status: 200, body: { success: false, message: 'Transaction not found' } })
    // Not-found is an answer, not an error: reconciliation wants to know it.
    const res = await api.pullTransaction({ accountId: 'HP56', transactionId: 'X' })
    expect(res.found).toBe(false)
  })

  it('coerces a string amount', async () => {
    const { api } = client({ status: 200, body: { success: true, data: { amount: '499' } } })
    expect((await api.pullTransaction({ accountId: 'HP56', transactionId: 'X' })).amount).toBe(499)
  })
})

describe('partner API', () => {
  it('lists linked accounts with the key in the query string', async () => {
    const { api, calls } = client({ status: 200, body: {
      ResultCode: '0', count: 2,
      summary: { total: 2 },
      billing: { mode: 'payg', token_balance: 480 },
      data: [{
        account_id: 'HPAP202608130417', accountName: 'Mama Njeri',
        accountType: 'CustomerPayBillOnline', paybill_no: '247247',
        status: 'payg', callback_webhook: 'https://example.com/hashback/callback',
      }],
    } })
    const res = await api.listLinkedAccounts()
    expect(calls[0].url).toContain(`API_KEY=${KEY}`)
    expect(calls[0].url).toContain(`${BASE}listlinkedaccounts`)
    expect(res.tokenBalance).toBe(480)
    expect(res.accounts[0]).toMatchObject({
      account_id: 'HPAP202608130417', paybill_no: '247247',
    })
  })

  it('creates a channel with the partner API_KEY body field', async () => {
    const { api, calls } = client({ status: 200, body: {
      ResultCode: '0', account_id: 'HPAP1', status: 'active',
      billing: { token_balance: 470 },
    } })
    const res = await api.linkAccount({
      accountName: 'Alpha ISP', accountType: 'CustomerPayBillOnline', paybillNo: '247247',
    })
    expect(body(calls[0])).toEqual({
      API_KEY: KEY, accountName: 'Alpha ISP',
      accountType: 'CustomerPayBillOnline', paybill_no: '247247',
    })
    expect(res.linked).toBe(true)
    expect(res.accountId).toBe('HPAP1')
    expect(res.tokenBalance).toBe(470)
  })

  it('sends till_no for a Buy Goods channel', async () => {
    const { api, calls } = client({ status: 200, body: { ResultCode: '0', account_id: 'HPX' } })
    await api.linkAccount({
      accountName: 'Alpha ISP', accountType: 'CustomerBuyGoodsOnline', tillNo: '522533',
    })
    expect(body(calls[0])).toMatchObject({
      till_no: '522533', accountType: 'CustomerBuyGoodsOnline',
    })
  })

  it('refuses a paybill link with no paybill, before spending 10 tokens', async () => {
    const { api, calls } = client({ status: 200, body: {} })
    await expect(api.linkAccount({
      accountName: 'Alpha ISP', accountType: 'CustomerPayBillOnline',
    })).rejects.toMatchObject({ kind: 'validation' })
    // Linking costs 10 tokens, so a bad request must never reach the provider.
    expect(calls).toHaveLength(0)
  })

  it('never auto-retries a link, which would create a duplicate channel', async () => {
    const impl = vi.fn(async () => new Response('{"message":"flaky"}', { status: 503 }))
    const api = new HashBackClient({
      apiKey: KEY, baseUrl: BASE, fetchImpl: impl as unknown as typeof fetch,
      sleepImpl: async () => {}, maxReadRetries: 2,
    })
    await expect(api.linkAccount({
      accountName: 'Alpha ISP', accountType: 'CustomerBuyGoodsOnline', tillNo: '522533',
    })).rejects.toMatchObject({ kind: 'provider' })
    // The docs state a repeat link returns a fresh account_id, so a retry here
    // would leave the ISP with two channels for one till.
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('edits an existing channel without creating a new one', async () => {
    const { api, calls } = client({ status: 200, body: { ResultCode: '0', message: 'updated' } })
    const res = await api.editLinkedAccount({
      accountId: 'HPAP1', accountType: 'CustomerPayBillOnline', accountName: 'Renamed',
    })
    expect(body(calls[0])).toMatchObject({ account_id: 'HPAP1', accountName: 'Renamed' })
    expect(res.updated).toBe(true)
  })

  it('rejects a non-HTTPS webhook URL', async () => {
    const { api, calls } = client({ status: 200, body: {} })
    // A plain-http callback would expose payment data in transit.
    await expect(api.registerWebhook({ callbackUrl: 'http://example.com/hook' }))
      .rejects.toMatchObject({ kind: 'validation' })
    expect(calls).toHaveLength(0)
  })

  it('registers an HTTPS webhook', async () => {
    const { api, calls } = client({ status: 200, body: { ResultCode: '0', message: 'ok' } })
    const res = await api.registerWebhook({
      callbackUrl: 'https://x.supabase.co/functions/v1/hashback-webhook',
    })
    expect(res.registered).toBe(true)
    expect(body(calls[0]).callback_url).toContain('https://')
  })

  it('reads the token balance with the API_KEY header', async () => {
    const { api, calls } = client({ status: 200, body: { balance: 470, rate_per_token: 1 } })
    const res = await api.getBalance()
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.API_KEY).toBe(KEY)
    // The key travels in the header, never the body, for this endpoint.
    expect(calls[0].init.body).toBeUndefined()
    expect(res).toMatchObject({ balance: 470, ratePerToken: 1 })
  })
})