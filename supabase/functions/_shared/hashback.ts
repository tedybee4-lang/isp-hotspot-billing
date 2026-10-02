// =============================================================================
//  HashBack provider client.
//
//  One canonical HTTP client for the HashBack/HashPay API. Every caller —
//  Edge Functions, the worker, server-side services — goes through this module,
//  so provider-specific request shapes, field names, error mapping, timeouts and
//  rate-limit handling exist in exactly one place.
//
//  This is the *provider adapter* only. It knows nothing about ISPs, invoices,
//  customers or plans. Resolving those, deciding the authoritative amount,
//  recording payments and activating service are the payment service's job (one
//  layer up). Keeping that boundary is what stops a provider change from
//  rippling into billing.
//
//  Credentials
//  -----------
//  Every method takes its key through `HashBackClient` construction, supplied by
//  the caller from the encrypted secret store. This module never reads an
//  environment variable, never logs a credential, and never places one in a
//  thrown error. Safe to import from any server-side code; must never be
//  imported from browser code.
//
//  Documentation baseline
//  ---------------------
//  Written against https://www.hashback.co.ke/documentation (verified). The
//  endpoints and their auth styles are recorded in ENDPOINTS so a future reader
//  can re-check them against the docs without archaeology.
//
//  Rate limits (per docs): 100 requests/minute across all endpoints; 429 with
//  `{ error: { code: 429, message } }`.
// =============================================================================

/** Base URL for the HashPay STK + PULL + partner products. */
export const HASHBACK_BASE_URL = 'https://api.hashback.co.ke/'

/**
 * Verified endpoints, kept together so the contract is auditable in one place.
 *
 * Auth column:
 *   body-api_key    → key in the JSON body as `api_key`
 *   body-API_KEY    → key in the JSON body as `API_KEY` (partner endpoints)
 *   header-API_KEY  → key as an `API_KEY` request header
 *   query-API_KEY   → key in the query string
 *
 * The docs genuinely differ per endpoint, and sending a key in the wrong place
 * is an authentication failure — so this is encoded rather than assumed.
 */
export const ENDPOINTS = {
  /** STK Push. Returns checkout_id / CheckoutRequestID / MerchantRequestID. */
  initiateStk: { path: 'initiatestk', auth: 'body-api_key' },
  /** Poll a STK Push by checkout id. */
  transactionStatus: { path: 'transactionstatus', auth: 'body-api_key' },
  /** PULL API — detailed transaction by id, for reconciliation. */
  pullTransaction: { path: 'v1/pullapi', auth: 'body-api_key' },
  /** Partner: list linked channels + token balance. */
  listLinkedAccounts: { path: 'listlinkedaccounts', auth: 'query-API_KEY' },
  /** Partner: create/link a channel (costs 10 tokens). */
  linkAccount: { path: 'linkaccount', auth: 'body-API_KEY' },
  /** Partner: update an existing channel. */
  editLinkedAccount: { path: 'editlinkedaccount', auth: 'body-API_KEY' },
  /** Partner: register a webhook URL. */
  registerWebhook: { path: 'registerwebhook', auth: 'body-API_KEY' },
  /** Service-token balance. Accepts header/bearer/query/body. */
  creditsBalance: { path: 'credits/balance', auth: 'header-API_KEY' },
} as const

export type EndpointName = keyof typeof ENDPOINTS

// -----------------------------------------------------------------------------
//  Structured errors
// -----------------------------------------------------------------------------

/**
 * Failure classes a caller must be able to tell apart.
 *
 * Why each matters in practice:
 *   auth       → wrong key; retrying is pointless and hides a config error.
 *   rate_limit → back off and retry later; not a failure.
 *   timeout    → we do not know if it landed; must NOT be auto-retried for a
 *                money-moving operation without idempotency.
 *   network    → same uncertainty as timeout.
 *   validation → our request was wrong; never retry unchanged.
 *   rejection  → provider understood and refused; no retry.
 *   provider   → 5xx; transient, bounded retry reasonable.
 *   malformed  → provider replied but not as documented; treat as a bug and do
 *                not silently coerce into a plausible value.
 */
export type HashBackErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'validation'
  | 'rejection'
  | 'provider'
  | 'malformed'
  | 'unknown'

/**
 * A provider error that is safe to log and safe to show an operator.
 *
 * Deliberately does NOT carry the API key, the request body, or any
 * credential-bearing header. `message` and `providerMessage` are client- or
 * provider-authored text only; `details` is populated from known-safe fields.
 */
export class HashBackError extends Error {
  readonly kind: HashBackErrorKind
  readonly status: number | null
  readonly providerCode: string | null
  readonly providerMessage: string | null
  readonly retryAfterMs: number | null
  readonly details: Record<string, unknown>

  constructor(init: {
    kind: HashBackErrorKind
    message: string
    status?: number | null
    providerCode?: string | null
    providerMessage?: string | null
    retryAfterMs?: number | null
    details?: Record<string, unknown>
  }) {
    super(init.message)
    this.name = 'HashBackError'
    this.kind = init.kind
    this.status = init.status ?? null
    this.providerCode = init.providerCode ?? null
    this.providerMessage = init.providerMessage ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.details = init.details ?? {}
  }

  /** Retrying unchanged could plausibly succeed. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'provider' ||
      this.kind === 'network'
  }

  /**
   * Whether an automatic retry is safe *for this operation*.
   *
   * A timeout or dropped connection during STK initiation is ambiguous: the
   * prompt may already have been sent. Re-sending risks a second prompt to a
   * customer who is entering their PIN, so money-moving operations never
   * auto-retry on those kinds. Read operations are safe to retry.
   */
  autoRetrySafe(operation: 'money-moving' | 'read'): boolean {
    if (operation === 'money-moving') {
      return this.kind === 'rate_limit' || this.kind === 'provider'
    }
    return this.retryable
  }
}

/** Narrow an unknown thrown value to a HashBackError for consistent handling. */
export function isHashBackError(err: unknown): err is HashBackError {
  return err instanceof HashBackError
}

// -----------------------------------------------------------------------------
//  Configuration
// -----------------------------------------------------------------------------

export interface HashBackClientOptions {
  /**
   * The API / partner key. Supplied by the caller from the encrypted store.
   * Never a NEXT_PUBLIC_ value, never logged.
   */
  apiKey: string
  /** Override the base URL (tests). */
  baseUrl?: string
  /** Per-request timeout in ms. Default 20s. */
  timeoutMs?: number
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected for tests; defaults to a real sleep. */
  sleepImpl?: (ms: number) => Promise<void>
  /**
   * Maximum automatic retries for *read* operations on transient failures.
   * Defaults to 2. Money-moving operations ignore this and never auto-retry.
   */
  maxReadRetries?: number
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_READ_RETRIES = 2

// -----------------------------------------------------------------------------
//  Input normalisation and validation (provider-facing)
// -----------------------------------------------------------------------------

/**
 * Normalises a Kenyan MSISDN to the `254XXXXXXXX` form the API documents.
 *
 * Accepts 0712345678, +254712345678, 254712345678, and tolerates spaces, dashes
 * and brackets. Returns null for anything that is not a plausible Kenyan mobile
 * number, so a caller can reject before spending a request.
 *
 * This is provider-facing normalisation only. The authoritative amount and the
 * tenant are resolved above this layer, never here.
 */
export function normaliseMsisdn(input: string): string | null {
  if (typeof input !== 'string') return null
  const digits = input.replace(/[\s\-()]/g, '').replace(/^\+/, '')
  if (!/^\d+$/.test(digits)) return null
  const normalised = digits.startsWith('0') ? '254' + digits.slice(1) : digits
  // Kenyan mobiles are 2547XXXXXXXX (Safaricom) and 2541XXXXXXXX (Airtel).
  // The API accepts any 254XXXXXXXX; anything else is rejected here.
  if (!/^254\d{9}$/.test(normalised)) return null
  return normalised
}

/**
 * Coerces an amount to the provider's documented string form.
 *
 * The API documents `amount` as a string in KES (e.g. "1"). We keep at most two
 * decimal places, trim a trailing ".00", and reject non-positive or non-finite
 * values.
 *
 * This does NOT decide what a customer should pay — that is the billing
 * service's job, from the package price. It only guarantees the value is
 * well-formed before it is sent.
 */
export function normaliseAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  // Two decimals then trim, so 100 never goes out as "100.0".
  return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

/**
 * Builds an opaque, unique payment reference.
 *
 * Satisfies three requirements: unique (the caller passes the payment id),
 * contains no credential or secret, and safe in a URL, a log line and a bank
 * statement. A UUID carries no meaning an attacker could use.
 */
export function buildReference(paymentId: string): string {
  // Strip anything that is not a UUID character, so a caller passing a compound
  // id cannot smuggle a slash or newline into the reference.
  const safe = paymentId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)
  return `NETISP-${safe || 'PAY'}`
}

// -----------------------------------------------------------------------------
//  The client
// -----------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST'
  /** JSON body. Merged with credentials according to the endpoint's auth style. */
  body?: Record<string, unknown>
  query?: Record<string, string | number | undefined>
  /** Marks the operation so retry policy can be operation-aware. */
  operation: 'money-moving' | 'read'
  /** Operation name, used only in safe error messages. */
  label: string
}

export class HashBackClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly maxReadRetries: number

  constructor(opts: HashBackClientOptions) {
    if (!opts?.apiKey) {
      throw new HashBackError({
        kind: 'auth',
        message: 'HashBack client requires an API key.',
      })
    }
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? HASHBACK_BASE_URL).replace(/\/+$/, '') + '/'
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxReadRetries = opts.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES
  }

  // -- core request -----------------------------------------------------------

  /**
   * Builds the URL, headers and body, placing the credential exactly where the
   * documented auth style for this endpoint requires it.
   */
  private buildUrl(
    endpoint: { path: string; auth: string },
    params: Record<string, unknown> = {},
  ): { url: string; headers: Record<string, string>; body?: Record<string, unknown> } {
    const url = new URL(endpoint.path, this.baseUrl)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: Record<string, unknown> | undefined

    switch (endpoint.auth) {
      case 'body-api_key':
        body = { ...params, api_key: this.apiKey }
        break
      case 'body-API_KEY':
        body = { ...params, API_KEY: this.apiKey }
        break
      case 'header-API_KEY':
        headers.API_KEY = this.apiKey
        break
      case 'query-API_KEY':
        url.searchParams.set('API_KEY', this.apiKey)
        break
    }

    return { url: url.toString(), headers, body }
  }

  /**
   * Performs one provider request, maps the outcome to a typed error, and — for
   * read operations only — retries bounded transient failures with exponential
   * backoff that respects Retry-After on 429.
   */
  private async request<T>(endpointName: EndpointName, opts: RequestOptions): Promise<T> {
    const endpoint = ENDPOINTS[endpointName]
    // Money-moving operations get exactly one attempt. See autoRetrySafe().
    const attempts = opts.operation === 'read' ? this.maxReadRetries + 1 : 1
    let lastError: HashBackError | null = null

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.attempt<T>(endpoint, opts)
      } catch (err) {
        const error = err instanceof HashBackError ? err : this.toUnknownError(err, opts.label)
        lastError = error

        const canRetry = attempt < attempts - 1 && error.autoRetrySafe(opts.operation)
        if (!canRetry) throw error

        // Honour Retry-After when present, otherwise capped exponential.
        const delay = error.retryAfterMs ?? Math.min(250 * 2 ** attempt, 4_000)
        await this.sleepImpl(delay)
      }
    }

    throw lastError ?? this.toUnknownError(new Error('unreachable'), opts.label)
  }

  /** One HTTP round-trip. Split out so `request` can wrap it with retries. */
  private async attempt<T>(
    endpoint: { path: string; auth: string },
    opts: RequestOptions,
  ): Promise<T> {
    const params = opts.body ?? opts.query ?? {}
    const { url, headers, body } = this.buildUrl(endpoint, params)
    // Only the documented GET endpoint is fetched by GET.
    const method = endpoint.path === ENDPOINTS.listLinkedAccounts.path ? 'GET' : 'POST'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      // Distinguish "we aborted" (timeout) from a genuine network failure. The
      // message is client-authored, so no credential can leak through it.
      const aborted = (err as Error)?.name === 'AbortError'
      throw new HashBackError({
        kind: aborted ? 'timeout' : 'network',
        message: aborted
          ? `${opts.label}: the provider did not respond within ${this.timeoutMs}ms.`
          : `${opts.label}: could not reach the provider.`,
        status: null,
      })
    } finally {
      clearTimeout(timer)
    }

    // Read once; the body is needed for both success parsing and error mapping.
    const rawText = await response.text().catch(() => '')

    if (!response.ok) {
      throw this.mapHttpError(response, rawText, opts.label)
    }

    if (rawText.trim() === '') {
      // A 2xx with an empty body is not a usable success for any documented
      // endpoint. Treat as malformed rather than inventing a result.
      throw new HashBackError({
        kind: 'malformed',
        message: `${opts.label}: provider returned an empty body.`,
        status: response.status,
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      throw new HashBackError({
        kind: 'malformed',
        message: `${opts.label}: provider returned a non-JSON body.`,
        status: response.status,
      })
    }

    return this.validateBody<T>(parsed, opts.label, response.status)
  }

  /**
   * Maps a non-2xx response to a typed error.
   *
   * Reads only the provider's own status, result code and message. It never
   * echoes the request body, which would contain the API key.
   */
  private mapHttpError(response: Response, rawText: string, label: string): HashBackError {
    const status = response.status
    let body: Record<string, unknown> = {}
    try {
      body = rawText ? JSON.parse(rawText) : {}
    } catch {
      body = {}
    }

    // Providers report their own status several ways; collect all of them.
    const nested = (typeof body.error === 'object' && body.error !== null)
      ? body.error as Record<string, unknown>
      : {}
    const providerCode = String(
      body.ResultCode ?? body.code ?? nested.code ?? body.ResponseCode ?? '',
    ) || null
    const providerMessage = String(
      body.message ?? nested.message ?? body.ResponseDescription ??
      body.ResultDesc ?? body.validation_error ?? '',
    ) || null

    // 429: honour Retry-After if present. Capped so a hostile value cannot pin
    // the worker for an hour.
    let retryAfterMs: number | null = null
    if (status === 429) {
      const seconds = Number(response.headers.get('Retry-After'))
      if (Number.isFinite(seconds) && seconds > 0) {
        retryAfterMs = Math.min(seconds * 1000, 60_000)
      }
    }

    if (status === 401 || status === 403 || providerCode === '401' || providerCode === '403') {
      return new HashBackError({
        kind: 'auth',
        message: `${label}: the provider rejected the API key (${status}).`,
        status, providerCode, providerMessage,
      })
    }

    if (status === 429) {
      return new HashBackError({
        kind: 'rate_limit',
        message: `${label}: rate limited by the provider.`,
        status, providerCode, providerMessage, retryAfterMs,
      })
    }

    if (status === 400 || status === 422 || providerCode === '400') {
      return new HashBackError({
        kind: 'validation',
        message: `${label}: the provider rejected the request.`,
        status, providerCode, providerMessage,
      })
    }

    if (status >= 500) {
      return new HashBackError({
        kind: 'provider',
        message: `${label}: the provider had a temporary failure (${status}).`,
        status, providerCode, providerMessage,
      })
    }

    return new HashBackError({
      kind: 'rejection',
      message: `${label}: the provider refused the request (${status}).`,
      status, providerCode, providerMessage,
    })
  }

  /**
   * Confirms a 2xx body is a JSON object, which every documented endpoint
   * returns. Kept thin on purpose: field-level checks live in each method so the
   * failure message can name the specific field that was missing.
   */
  private validateBody<T>(parsed: unknown, label: string, status: number): T {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HashBackError({
        kind: 'malformed',
        message: `${label}: provider returned an unexpected shape.`,
        status,
      })
    }
    return parsed as T
  }

  private toUnknownError(err: unknown, label: string): HashBackError {
    return new HashBackError({
      kind: 'unknown',
      message: `${label}: ${(err as Error)?.message ?? 'unexpected error'}`,
    })
  }

  private optionalString(body: Record<string, unknown>, field: string): string | null {
    const value = body[field]
    return typeof value === 'string' && value !== '' ? value : null
  }

  // -- typed operations -------------------------------------------------------

  /**
   * Initiates an STK Push.
   *
   * IMPORTANT: `accepted: true` means the prompt was accepted for processing. It
   * does NOT mean the customer paid. Settlement only happens on a verified
   * webhook or a verified status/pull. Callers must never mark a payment
   * successful on this result.
   *
   * Never auto-retried: a timeout is ambiguous, and a resend risks a second
   * prompt to a customer who is already entering their PIN.
   */
  async initiateStk(input: {
    accountId: string
    amount: number
    msisdn: string
    reference: string
  }): Promise<{
    accepted: boolean
    checkoutId: string | null
    merchantRequestId: string | null
    responseCode: string | null
    message: string
  }> {
    const msisdn = normaliseMsisdn(input.msisdn)
    if (!msisdn) {
      throw new HashBackError({
        kind: 'validation',
        message: 'initiateStk: msisdn is not a valid Kenyan mobile number.',
        details: { field: 'msisdn' },
      })
    }
    const amount = normaliseAmount(input.amount)
    if (!amount) {
      throw new HashBackError({
        kind: 'validation',
        message: 'initiateStk: amount must be a positive number.',
        details: { field: 'amount' },
      })
    }

    const body = await this.request<Record<string, unknown>>('initiateStk', {
      method: 'POST',
      operation: 'money-moving',
      label: 'initiateStk',
      body: {
        account_id: input.accountId,
        amount,
        msisdn,
        reference: input.reference,
      },
    })

    // The docs promise `success` and `checkout_id` on acceptance.
    const accepted = body.success === true
    return {
      accepted,
      checkoutId: this.optionalString(body, 'checkout_id'),
      merchantRequestId: this.optionalString(body, 'MerchantRequestID'),
      responseCode: this.optionalString(body, 'ResponseCode'),
      message: this.optionalString(body, 'CustomerMessage')
        ?? this.optionalString(body, 'ResponseDescription')
        ?? (accepted ? 'STK prompt sent.' : 'STK prompt was refused.'),
    }
  }

  /**
   * Polls the provider for a checkout's current state.
   *
   * A read operation, so transient failures are retried. This is the recovery
   * path when a webhook is lost or delayed.
   *
   * Note on the documented response: the docs show a minimal acknowledgement
   * body for this endpoint. Where it does not carry a definitive outcome we
   * return 'pending' rather than guessing — reconciliation then waits for a real
   * webhook or PULL result instead of settling on ambiguous data.
   */
  async getTransactionStatus(input: {
    accountId: string
    checkoutId: string
  }): Promise<{
    state: 'success' | 'failed' | 'pending'
    resultCode: string | null
    description: string | null
    raw: Record<string, unknown>
  }> {
    const body = await this.request<Record<string, unknown>>('transactionStatus', {
      method: 'POST',
      operation: 'read',
      label: 'transactionStatus',
      body: { account_id: input.accountId, checkoutid: input.checkoutId },
    })

    const resultCode = this.optionalString(body, 'ResultCode')
    const description = this.optionalString(body, 'ResponseDescription')
      ?? this.optionalString(body, 'ResultDesc')

    // A non-zero ResultCode settles as failed. "0" alone only means
    // accepted-for-processing, which is not payment.
    let state: 'success' | 'failed' | 'pending' = 'pending'
    if (resultCode && resultCode !== '0') {
      state = 'failed'
    } else if (this.optionalString(body, 'TransactionStatus')?.toLowerCase() === 'success') {
      state = 'success'
    }

    return { state, resultCode, description, raw: body }
  }

  /**
   * PULL API — detailed transaction lookup by provider transaction id.
   *
   * The reconciliation workhorse: it returns amount, bill reference and
   * transaction id, which together are enough to match a provider record to a
   * stored payment and settle it safely and idempotently.
   */
  async pullTransaction(input: {
    accountId: string
    transactionId: string
  }): Promise<{
    found: boolean
    amount: number | null
    billReference: string | null
    transactionId: string | null
    raw: Record<string, unknown>
  }> {
    const body = await this.request<Record<string, unknown>>('pullTransaction', {
      method: 'POST',
      operation: 'read',
      label: 'pullTransaction',
      body: { account_id: input.accountId, transaction_id: input.transactionId },
    })

    // The docs return `{ success:false }` for not-found; a 404 is handled as a
    // thrown rejection above. Reaching here with success:false is still a
    // legitimate "not found" answer, so it is returned rather than thrown.
    if (body.success === false) {
      return {
        found: false, amount: null, billReference: null, transactionId: null, raw: body,
      }
    }

    const data = (typeof body.data === 'object' && body.data !== null)
      ? body.data as Record<string, unknown>
      : body

    const amountRaw = data.amount
    const amount = typeof amountRaw === 'number' ? amountRaw
      : typeof amountRaw === 'string' ? Number(amountRaw) : null

    return {
      found: true,
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
      billReference: this.optionalString(data, 'billreference'),
      transactionId: this.optionalString(data, 'transactionId'),
      raw: body,
    }
  }

  /**
   * Partner API — lists the channels linked under the partner account, plus the
   * service-token balance.
   *
   * This is how "Connect & Verify" proves partner access is real rather than
   * assumed. If it throws an auth error, partner access is genuinely unavailable
   * and the UI must say so instead of pretending.
   */
  async listLinkedAccounts(input: { status?: string } = {}): Promise<{
    count: number
    tokenBalance: number | null
    accounts: Array<{
      account_id: string
      accountName: string | null
      accountType: string | null
      paybill_no: string | null
      till_no: string | null
      status: string | null
      callback_webhook: string | null
    }>
    raw: Record<string, unknown>
  }> {
    const query: Record<string, string | number | undefined> = {}
    if (input.status) query.status = input.status

    const body = await this.request<Record<string, unknown>>('listLinkedAccounts', {
      operation: 'read',
      label: 'listLinkedAccounts',
      query,
    })

    const billing = (typeof body.billing === 'object' && body.billing !== null)
      ? body.billing as Record<string, unknown>
      : {}

    const data = Array.isArray(body.data) ? body.data : []
    const accounts = data.map((entry) => {
      const e = (typeof entry === 'object' && entry !== null)
        ? entry as Record<string, unknown>
        : {}
      return {
        account_id: this.optionalString(e, 'account_id') ?? '',
        accountName: this.optionalString(e, 'accountName'),
        accountType: this.optionalString(e, 'accountType'),
        paybill_no: this.optionalString(e, 'paybill_no'),
        till_no: this.optionalString(e, 'till_no'),
        status: this.optionalString(e, 'status'),
        callback_webhook: this.optionalString(e, 'callback_webhook'),
      }
    }).filter((a) => a.account_id !== '')

    return {
      count: typeof body.count === 'number' ? body.count : accounts.length,
      tokenBalance: typeof billing.token_balance === 'number' ? billing.token_balance : null,
      accounts,
      raw: body,
    }
  }

  /**
   * Partner API — creates/links a new collection channel.
   *
   * Costs 10 service tokens on success. Deliberately NOT auto-retried: the docs
   * state that re-linking the same shortcode returns a *fresh* account_id, so an
   * automatic retry would silently create a duplicate channel. The caller checks
   * for an existing channel first.
   */
  async linkAccount(input: {
    accountName: string
    accountType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
    paybillNo?: string
    tillNo?: string
    accountNo?: string
    callbackWebhook?: string
  }): Promise<{
    linked: boolean
    accountId: string | null
    status: string | null
    tokenBalance: number | null
    message: string
    raw: Record<string, unknown>
  }> {
    const body: Record<string, unknown> = {
      accountName: input.accountName,
      accountType: input.accountType,
    }
    if (input.accountType === 'CustomerPayBillOnline') {
      if (!input.paybillNo) {
        throw new HashBackError({
          kind: 'validation',
          message: 'linkAccount: paybill_no is required for CustomerPayBillOnline.',
          details: { field: 'paybill_no' },
        })
      }
      body.paybill_no = input.paybillNo
    } else {
      if (!input.tillNo) {
        throw new HashBackError({
          kind: 'validation',
          message: 'linkAccount: till_no is required for CustomerBuyGoodsOnline.',
          details: { field: 'till_no' },
        })
      }
      body.till_no = input.tillNo
    }
    if (input.accountNo) body.account_no = input.accountNo
    if (input.callbackWebhook) body.callback_webhook = input.callbackWebhook

    const res = await this.request<Record<string, unknown>>('linkAccount', {
      method: 'POST',
      operation: 'money-moving',
      label: 'linkAccount',
      body,
    })

    const billing = (typeof res.billing === 'object' && res.billing !== null)
      ? res.billing as Record<string, unknown>
      : {}
    const accountId = this.optionalString(res, 'account_id')

    return {
      // An account_id is the authoritative proof the channel exists.
      linked: res.ResultCode === '0' || accountId !== null,
      accountId,
      status: this.optionalString(res, 'status'),
      tokenBalance: typeof billing.token_balance === 'number' ? billing.token_balance : null,
      message: this.optionalString(res, 'message') ?? 'Channel linked.',
      raw: res,
    }
  }

  /**
   * Partner API — updates an existing channel (rename, change shortcode, set or
   * clear a per-channel webhook).
   *
   * Free per the docs, and safe to retry because it never creates a duplicate.
   */
  async editLinkedAccount(input: {
    accountId: string
    accountType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
    accountName?: string
    paybillNo?: string
    tillNo?: string
    accountNo?: string
    callbackWebhook?: string
  }): Promise<{ updated: boolean; message: string; raw: Record<string, unknown> }> {
    const body: Record<string, unknown> = {
      account_id: input.accountId,
      accountType: input.accountType,
    }
    if (input.accountName) body.accountName = input.accountName
    if (input.paybillNo) body.paybill_no = input.paybillNo
    if (input.tillNo) body.till_no = input.tillNo
    // `!== undefined` so an empty string clears the value, as the docs allow.
    if (input.accountNo !== undefined) body.account_no = input.accountNo
    if (input.callbackWebhook !== undefined) body.callback_webhook = input.callbackWebhook

    const res = await this.request<Record<string, unknown>>('editLinkedAccount', {
      method: 'POST',
      operation: 'money-moving',
      label: 'editLinkedAccount',
      body,
    })

    return {
      updated: res.ResultCode === '0' || res.success === true,
      message: this.optionalString(res, 'message') ?? 'Channel updated.',
      raw: res,
    }
  }

  /**
   * Partner API — registers a webhook URL for callbacks.
   *
   * The docs also describe a global webhook configured in the portal, which is
   * preferred because it covers channels linked later with no further call. This
   * method exists for when the platform must set it programmatically; the admin
   * UI shows the exact URL either way so a platform owner can register it
   * manually if partner access is limited.
   */
  async registerWebhook(input: {
    callbackUrl: string
    accountId?: string
  }): Promise<{ registered: boolean; message: string; raw: Record<string, unknown> }> {
    // Must be absolute HTTPS: a relative value would post callbacks nowhere
    // useful, and the docs reject it.
    let parsed: URL
    try {
      parsed = new URL(input.callbackUrl)
    } catch {
      throw new HashBackError({
        kind: 'validation',
        message: 'registerWebhook: callbackUrl must be an absolute URL.',
        details: { field: 'callbackUrl' },
      })
    }
    if (parsed.protocol !== 'https:') {
      throw new HashBackError({
        kind: 'validation',
        message: 'registerWebhook: callbackUrl must use HTTPS.',
        details: { field: 'callbackUrl' },
      })
    }

    const res = await this.request<Record<string, unknown>>('registerWebhook', {
      method: 'POST',
      operation: 'money-moving',
      label: 'registerWebhook',
      body: input.accountId
        ? { callback_url: input.callbackUrl, account_id: input.accountId }
        : { callback_url: input.callbackUrl },
    })

    return {
      registered: res.ResultCode === '0' || res.success === true,
      message: this.optionalString(res, 'message') ?? 'Webhook registered.',
      raw: res,
    }
  }

  /**
   * Service-token balance. Header auth per the docs.
   *
   * Used by "Connect & Verify" to prove API access and show remaining tokens.
   * The docs state this call is free and spends no token.
   */
  async getBalance(): Promise<{
    balance: number | null
    ratePerToken: number | null
    raw: Record<string, unknown>
  }> {
    const res = await this.request<Record<string, unknown>>('creditsBalance', {
      operation: 'read',
      label: 'creditsBalance',
    })
    return {
      balance: typeof res.balance === 'number' ? res.balance : null,
      ratePerToken: typeof res.rate_per_token === 'number' ? res.rate_per_token : null,
      raw: res,
    }
  }
}