// =============================================================================
//  HashBack webhook signature verification.
//
//  Deliberately a separate module from hashback.ts and separate from any JSON
//  parsing middleware. Signature verification must happen on the RAW request
//  bytes, before the body is parsed and before any of its contents are
//  believed. A design where verification sits inside a JSON middleware is a
//  design where a future refactor can silently reorder those two steps, which
//  turns "verify then parse" into "parse then verify" — and that is how a
//  forged webhook activates a customer's service.
//
//  Documented scheme (https://www.hashback.co.ke/documentation, verified):
//
//    header   X-Hashpay-Signature
//    value    sha256=<hex-digest>
//    digest   HMAC-SHA256 over the RAW, unmodified request body
//    secret   the channel's webhook secret from the HashPay portal
//
//  The docs are explicit that the HMAC is computed over the raw bytes, not a
//  re-serialised JSON string: any whitespace difference causes a mismatch.
//  Therefore this module takes bytes, never a parsed object.
// =============================================================================

/** The documented signature header. */
export const SIGNATURE_HEADER = 'x-hashpay-signature'

/** The documented prefix on the signature value. */
export const SIGNATURE_PREFIX = 'sha256='

/** Minimal view of a request header bag, so this works on any runtime. */
export type HeaderLookup = {
  get(name: string): string | null
}

/**
 * Why a webhook was rejected.
 *
 * Distinct kinds matter: a missing header and a bad signature both mean 401,
 * but an operator diagnosing an outage needs to tell "the provider is not
 * signing" apart from "someone is forging calls".
 */
export type WebhookRejectReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'secret_not_configured'
  | 'signature_mismatch'

export class WebhookSignatureError extends Error {
  readonly reason: WebhookRejectReason

  constructor(reason: WebhookRejectReason, message: string) {
    super(message)
    this.name = 'WebhookSignatureError'
    this.reason = reason
  }
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compares two strings in constant time relative to their contents.
 *
 * A byte-by-byte `===` returns as soon as it finds a difference, and the time it
 * takes therefore leaks how many leading characters were correct. Over a network
 * that is enough to reconstruct a signature one character at a time, so the
 * comparison must not short-circuit.
 *
 * `crypto.subtle` has no timing-safe compare, so this does the equivalent
 * manually: accumulate differences over every position without branching, then
 * check the accumulator once at the end.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)

  // Length is not secret: the digest length is fixed and public. Comparing it
  // first avoids an out-of-bounds read below without leaking anything useful.
  if (left.length !== right.length) return false

  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i]
  }
  return diff === 0
}

/**
 * Computes the expected signature value for a raw body.
 *
 * Returns the full header value including the `sha256=` prefix, so a caller
 * compares like with like and cannot accidentally compare a digest against a
 * prefixed string.
 */
export async function computeSignature(
  rawBody: Uint8Array,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // A fresh ArrayBuffer view: the digest must cover exactly these bytes.
  const view = new Uint8Array(rawBody.length)
  view.set(rawBody)
  const digest = await crypto.subtle.sign('HMAC', key, view)
  return `${SIGNATURE_PREFIX}${hex(digest)}`
}

/**
 * Verifies a webhook signature.
 *
 * Throws `WebhookSignatureError` on any failure, so a caller cannot accidentally
 * continue processing on an ignored return value.
 *
 * @param rawBody    The exact request bytes. NOT a parsed object, NOT a
 *                   re-serialised string.
 * @param signatureHeader The value of the X-Hashpay-Signature header.
 * @param secret     The channel's webhook secret.
 */
export async function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<void> {
  if (!secret) {
    // Without a secret nothing can be verified, so nothing may be processed.
    // This is the "webhook not configured" case, not an auth failure.
    throw new WebhookSignatureError(
      'secret_not_configured',
      'No webhook secret is configured for this channel.',
    )
  }

  if (signatureHeader === null || signatureHeader === undefined || signatureHeader === '') {
    throw new WebhookSignatureError(
      'missing_signature',
      `Missing ${SIGNATURE_HEADER} header.`,
    )
  }

  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    throw new WebhookSignatureError(
      'malformed_signature',
      'Signature header is not in sha256=<hex> form.',
    )
  }

  const expected = await computeSignature(rawBody, secret)

  // Constant-time: an attacker must not learn the digest a byte at a time.
  if (!timingSafeEqual(expected, signatureHeader)) {
    throw new WebhookSignatureError('signature_mismatch', 'Signature does not match.')
  }
}

/** Reads and verifies the signature from a request's headers in one step. */
export async function verifyWebhookRequest(
  headers: HeaderLookup,
  rawBody: Uint8Array,
  secret: string,
): Promise<void> {
  await verifyWebhookSignature(rawBody, headers.get(SIGNATURE_HEADER), secret)
}

// -----------------------------------------------------------------------------
//  Payload shape
// -----------------------------------------------------------------------------

/**
 * A HashBack STK webhook, as documented.
 *
 * Every field is optional at the type level because the provider sends different
 * subsets per event type — a `payment.success` carries all of them, while a
 * failure event may omit the receipt. The accessor helpers below are what the
 * payment service should use, so a missing field becomes an explicit "unknown"
 * rather than an `undefined` that silently flows into an activation path.
 */
export interface HashBackWebhookPayload {
  event?: string
  ResponseCode?: number | string
  ResponseDescription?: string
  MerchantRequestID?: string
  CheckoutRequestID?: string
  TransactionID?: string
  TransactionAmount?: number | string
  TransactionReceipt?: string
  TransactionDate?: string | number
  TransactionReference?: string
  /**
   * The documented example carries Msisdn as a JSON *number* (254701234567).
   * Typed to match reality rather than the convenient assumption, so the
   * compiler catches a caller that forgets to normalise it.
   */
  Msisdn?: string | number
  AccountID?: string
}

/** Event names the provider documents for STK. */
export const WEBHOOK_EVENTS = {
  success: 'payment.success',
} as const

/**
 * Decides whether a webhook represents a settled, successful payment.
 *
 * Requires agreement between the event name and the numeric response code.
 * Checking both is deliberate: `ResponseCode: 0` on its own also appears on
 * *initiation* acknowledgements, and treating that as a paid payment would
 * activate service for a prompt nobody entered a PIN for.
 */
export function isSuccessfulPayment(payload: HashBackWebhookPayload): boolean {
  if (payload.event !== WEBHOOK_EVENTS.success) return false
  return Number(payload.ResponseCode) === 0
}

/**
 * Pulls the fields the payment service needs to settle a transaction.
 *
 * Returns nulls rather than throwing when a field is absent, because the caller
 * decides which absences are fatal. A missing AccountID is fatal (we cannot
 * route); a missing receipt is merely untidy.
 */
export function readSettlementFields(payload: HashBackWebhookPayload): {
  accountId: string | null
  transactionId: string | null
  receipt: string | null
  reference: string | null
  checkoutId: string | null
  merchantRequestId: string | null
  msisdn: string | null
  amount: number | null
} {
  const str = (v: unknown): string | null => {
    if (typeof v === 'string' && v !== '') return v
    // The documented example carries Msisdn as a JSON number, so identifiers
    // may arrive numeric. Coerce integral numbers to their string form; a
    // non-integral one is not a valid MSISDN and is rejected rather than
    // mangled into "254.7".
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v)
    return null
  }
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  return {
    accountId: str(payload.AccountID),
    transactionId: str(payload.TransactionID),
    receipt: str(payload.TransactionReceipt),
    reference: str(payload.TransactionReference),
    checkoutId: str(payload.CheckoutRequestID),
    merchantRequestId: str(payload.MerchantRequestID),
    msisdn: str(payload.Msisdn),
    amount: num(payload.TransactionAmount),
  }
}