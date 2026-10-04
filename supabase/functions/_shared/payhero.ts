// =============================================================================
//  PayHero provider client.
//
//  One canonical HTTP client for the PayHero Kenya API, structured like
//  `_shared/hashback.ts`: this module is the PROVIDER ADAPTER only. It knows
//  nothing about ISPs, invoices, customers or plans. Resolving those, deciding
//  the authoritative amount, recording payments and activating service belong to
//  the payment service one layer up.
//
//  AUTHENTICATION — READ THIS BEFORE ASKING FOR A LOGIN
//  ----------------------------------------------------
//  PayHero does NOT offer OAuth. There is no authorization endpoint, no authorize
//  redirect, no access token, no refresh token, and no delegated or "Connect
//  App" flow. This was verified against PayHero's own published documentation,
//  which describes every endpoint with one required header and documents no other
//  authentication scheme anywhere:
//
//      Authorization: Basic auth token
//
//  A "LOGIN / CONNECT PAYHERO" button that redirected the user to PayHero to
//  grant access would be fiction: there is nothing to redirect to. The credential
//  is a long-lived username/password pair, so it must be entered once by a
//  platform admin and then encrypted at rest. That is why the connection page has
//  a credentials form, and the form is not an oversight to be worked around.
//
//  Because that credential is long-lived rather than scoped or revocable by
//  delegation, it is treated as a PLATFORM SECRET: AES-GCM ciphertext at rest
//  (service role only), never returned to a browser, never logged, never visible
//  to an ISP admin, and never exposed in an API response.
//
//  Documentation baseline
//  ---------------------
//  Written against https://docs.payhero.co.ke (verified), base
//  https://backend.payhero.co.ke. Endpoints are recorded in PAYHERO_ENDPOINTS so
//  a future reader can re-check them without archaeology.
// =============================================================================

/** Base URL for the PayHero API. */
export const PAYHERO_BASE_URL = 'https://backend.payhero.co.ke'

/**
 * Verified endpoints.
 *
 * Every one takes the credential as a Basic auth header. There is no OAuth
 * variant, so there is no per-endpoint auth style to get wrong.
 */
export const PAYHERO_ENDPOINTS = {
  /** Initiate an M-Pesa STK push. Returns a transaction reference. */
  initiateStk: '/api/v2/payments',
  /** Channels (Till/PayBill) registered on the account. Drives discovery. */
  paymentChannels: '/api/v2/payment_channels',
  /** Wallets held by the account, including the service wallet balance. */
  wallets: '/api/v2/wallets',
  /** Authoritative transaction status by our external reference. */
  transactionStatus: '/api/v2/transaction-status',
} as const

export type PayHeroEndpointName = keyof typeof PAYHERO_ENDPOINTS

// The provider error type and the amount/phone normalisers are shared with the
// HashBack client on purpose: the payment service then handles one error
// contract regardless of which provider it is talking to.
import { HashBackError, normaliseAmount, normaliseMsisdn } from './hashback.ts'
export { HashBackError, isHashBackError } from './hashback.ts'
export type { HashBackErrorKind } from './hashback.ts'

/**
 * A payment channel registered on the PayHero account.
 *
 * `id` is what an STK push is addressed to (`channel_id`), so it is PayHero's
 * equivalent of HashBack's `account_id`: the per-channel destination a prompt is
 * charged to. One channel id therefore maps to one ISP's Till or PayBill.
 */
export interface PayHeroChannel {
  id: number
  channel_type: string
  transaction_type: string
  account_id: number
  short_code: string
  account_number: string
  description: string
  is_active: boolean
}

export interface PayHeroWallet {
  id: number
  account_id: number
  wallet_type: string
  currency: string
  available_balance: number
  wallet_status: string
}

/** What the connection screen needs, gathered in one pass. */
export interface PayHeroConnection {
  accountId: number | null
  balance: number | null
  currency: string | null
  channels: PayHeroChannel[]
  apiReachable: boolean
  lastError: string | null
}

export interface PayHeroClientOptions {
  /**
   * The Basic auth token, supplied by the caller from the encrypted store.
   * Never a NEXT_PUBLIC_ value, never logged, never in an error message.
   */
  apiToken: string
  /** Override the base URL (tests). */
  baseUrl?: string
  /** Per-request timeout in ms. Default 20s. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}
/** Canonical PayHero client. */
export class PayHeroClient {
  private readonly token: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: PayHeroClientOptions) {
    this.token = options.apiToken
    this.baseUrl = (options.baseUrl ?? PAYHERO_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Lists the Till/PayBill channels registered on the account. */
  async listChannels(isActive?: boolean): Promise<PayHeroChannel[]> {
    const query = isActive === undefined ? '' : `?is_active=${isActive}`
    const body = await this.request<{ payment_channels?: PayHeroChannel[] }>(
      'paymentChannels',
      { method: 'GET', path: PAYHERO_ENDPOINTS.paymentChannels + query },
    )
    return Array.isArray(body.payment_channels) ? body.payment_channels : []
  }

  /** Wallets for the account; the service wallet carries the spendable balance. */
  async listWallets(): Promise<PayHeroWallet[]> {
    const body = await this.request<PayHeroWallet | PayHeroWallet[]>('wallets', {
      method: 'GET',
      path: PAYHERO_ENDPOINTS.wallets,
    })
    return Array.isArray(body) ? body : [body]
  }

  /**
   * Sends an STK push.
   *
   * The amount, the channel and the reference all come from the caller, which is
   * safe ONLY because the payment service resolves every one of them
   * server-side. This adapter never invents a value and reads an amount from
   * nowhere else.
   */
  async initiateStk(input: {
    channelId: number
    amount: number
    phoneNumber: string
    externalReference: string
    customerName?: string
    callbackUrl?: string
  }): Promise<{ accepted: boolean; reference: string | null; message: string }> {
    const msisdn = normaliseMsisdn(input.phoneNumber)
    if (!msisdn) {
      throw new HashBackError({
        kind: 'validation',
        message: 'initiateStk: phone_number is not a valid Kenyan mobile number.',
        details: { field: 'phone_number' },
      })
    }
    if (!normaliseAmount(input.amount)) {
      throw new HashBackError({
        kind: 'validation',
        message: 'initiateStk: amount must be a positive number.',
        details: { field: 'amount' },
      })
    }
    if (!Number.isInteger(input.channelId) || input.channelId <= 0) {
      throw new HashBackError({
        kind: 'validation',
        message: 'initiateStk: channel_id must be a registered channel id.',
        details: { field: 'channel_id' },
      })
    }

    const payload: Record<string, unknown> = {
      amount: Math.round(input.amount),
      phone_number: msisdn,
      channel_id: input.channelId,
      provider: 'm-pesa',
      external_reference: input.externalReference,
    }
    if (input.customerName) payload.customer_name = input.customerName
    if (input.callbackUrl) payload.callback_url = input.callbackUrl

    const body = await this.request<Record<string, unknown>>('initiateStk', {
      method: 'POST',
      path: PAYHERO_ENDPOINTS.initiateStk,
      json: payload,
    })

    // PayHero signals acceptance by returning a reference; it has no boolean
    // success flag, so the reference's presence is the acceptance signal. An
    // absent reference means the prompt was NOT sent, and the caller must treat
    // that as a failure rather than as a pending payment.
    const reference =
      this.string(body, 'reference') ??
      this.string(body, 'transaction_reference') ??
      this.string(body, 'external_reference')
    return {
      accepted: reference !== null,
      reference,
      message:
        this.string(body, 'status') ??
        this.string(body, 'message') ??
        (reference ? 'STK prompt sent.' : 'STK prompt was refused.'),
    }
  }

  /**
   * Authoritative status for a transaction.
   *
   * This is the verification path. STK initiation is a request for a prompt, not
   * proof of payment, so nothing may be activated on the strength of that call.
   */
  async getTransactionStatus(
    reference: string,
  ): Promise<{ state: 'success' | 'failed' | 'pending'; raw: Record<string, unknown> }> {
    const body = await this.request<Record<string, unknown>>('transactionStatus', {
      method: 'GET',
      path: `${PAYHERO_ENDPOINTS.transactionStatus}?reference=${encodeURIComponent(reference)}`,
    })
    // PayHero documents no ResultCode for this endpoint, so success is read from
    // the recorded status string rather than invented.
    const recorded = String(body.status ?? body.transaction_status ?? '')
    const state = /success|completed|settled|paid/i.test(recorded)
      ? 'success'
      : /fail|revert|cancel/i.test(recorded)
        ? 'failed'
        : 'pending'
    return { state, raw: body }
  }
/**
 * One pass against the account: channels plus wallet balance.
 *
 * Drives the connection screen, so an operator sees the real state of the
 * connection rather than a stored flag that may have gone stale.
 */
  async inspect(): Promise<PayHeroConnection> {
    const [channels, wallets] = await Promise.all([this.listChannels(), this.listWallets()])
    const service = wallets.find((w) => w.wallet_type === 'service_wallet') ?? wallets[0]
    return {
      accountId: service?.account_id ?? channels[0]?.account_id ?? null,
      balance: service?.available_balance ?? null,
      currency: service?.currency ?? null,
      channels,
      apiReachable: true,
      lastError: null,
    }
  }

  private string(body: unknown, key: string): string | null {
    if (!body || typeof body !== 'object') return null
    const value = (body as Record<string, unknown>)[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  /**
   * Issues one request with the Basic credential attached.
   *
   * Never logs the credential and never places it in a thrown error: only the
   * status code and provider-authored text escape.
   */
  private async request<T>(
    label: PayHeroEndpointName,
    opts: { method: string; path: string; json?: unknown },
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${opts.path}`, {
        method: opts.method,
        headers: {
          Authorization: `Basic ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: controller.signal,
      })
    } catch (err) {
      throw new HashBackError({
        kind: (err as Error)?.name === 'AbortError' ? 'timeout' : 'network',
        message: `${label}: could not reach PayHero.`,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      throw new HashBackError({
        kind: 'malformed',
        message: `${label}: PayHero returned a response that is not JSON.`,
        status: res.status,
      })
    }

    if (!res.ok) {
      const record = (parsed ?? {}) as { error_message?: string; message?: string }
      const providerMessage = record.error_message ?? record.message ?? null
      // 401/403 is a credential problem, which no retry can fix, so it must not be
      // reported as a transient provider fault.
      const kind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate_limit'
            : res.status >= 500
              ? 'provider'
              : 'rejection'
      throw new HashBackError({
        kind,
        message: `${label}: PayHero refused the request (HTTP ${res.status}).`,
        status: res.status,
        providerCode: String(res.status),
        providerMessage,
      })
    }

    return parsed as T
  }
}

/** Narrowing helper for the shared provider error type. */
export function isPayHeroError(err: unknown): err is HashBackError {
  return err instanceof HashBackError
}
