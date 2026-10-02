/**
 * Webhook signature verification tests.
 *
 * These assert the security boundary itself. Every one of them is a way an
 * attacker could otherwise activate a customer's service without any money
 * moving, which is why they are checked directly rather than only through the
 * payment flow.
 */
import { describe, expect, it } from 'vitest'
import {
  computeSignature,
  verifyWebhookSignature,
  verifyWebhookRequest,
  timingSafeEqual,
  isSuccessfulPayment,
  readSettlementFields,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  WebhookSignatureError,
  type HashBackWebhookPayload,
} from './hashback-webhook.ts'

const SECRET = 'test-webhook-secret-not-real'

const bytes = (s: string) => new TextEncoder().encode(s)

/** A realistic documented success payload. */
const SUCCESS_PAYLOAD = {
  event: 'payment.success',
  ResponseCode: 0,
  ResponseDescription: 'Success. Request accepted for processing',
  MerchantRequestID: 'ws_CO_12052026084940',
  CheckoutRequestID: 'ws_CO_12052026084940776662',
  TransactionID: 'UEC496402X',
  TransactionAmount: 1,
  TransactionReceipt: 'UEC496402X',
  TransactionDate: 20260512084950,
  TransactionReference: 'HPL1XBF0',
  Msisdn: 254701234567,
  AccountID: 'HP56',
} as const

describe('computeSignature', () => {
  it('produces the documented sha256=<hex> format', async () => {
    const sig = await computeSignature(bytes('{}'), SECRET)
    expect(sig.startsWith(SIGNATURE_PREFIX)).toBe(true)
    expect(sig.slice(SIGNATURE_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for the same body and secret', async () => {
    expect(await computeSignature(bytes('{"a":1}'), SECRET))
      .toBe(await computeSignature(bytes('{"a":1}'), SECRET))
  })

  it('changes when the body changes by one byte', async () => {
    // This is what makes whitespace-significant verification work.
    expect(await computeSignature(bytes('{"a": 1}'), SECRET))
      .not.toBe(await computeSignature(bytes('{"a":1}'), SECRET))
  })

  it('changes when the secret changes', async () => {
    expect(await computeSignature(bytes('{}'), SECRET))
      .not.toBe(await computeSignature(bytes('{}'), `${SECRET}x`))
  })
})

describe('timingSafeEqual', () => {
  it('matches identical strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('rejects different strings', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  it('rejects a prefix match, which a naive loop would accept', () => {
    // A loop that stops at the first difference would return true here.
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false)
  })

  it('rejects different lengths', () => {
    expect(timingSafeEqual('', 'a')).toBe(false)
  })
})

describe('verifyWebhookSignature', () => {
  it('accepts a correct signature', async () => {
    const body = bytes(JSON.stringify(SUCCESS_PAYLOAD))
    const sig = await computeSignature(body, SECRET)
    await expect(verifyWebhookSignature(body, sig, SECRET)).resolves.toBeUndefined()
  })

  it('rejects a wrong signature', async () => {
    const body = bytes(JSON.stringify(SUCCESS_PAYLOAD))
    const sig = await computeSignature(body, 'a-different-secret')
    await expect(verifyWebhookSignature(body, sig, SECRET))
      .rejects.toMatchObject({ reason: 'signature_mismatch' })
  })

  it('rejects a body altered after signing', async () => {
    // The classic attack: sign one payload, send another.
    const signed = bytes(JSON.stringify(SUCCESS_PAYLOAD))
    const sig = await computeSignature(signed, SECRET)
    const tampered = bytes(JSON.stringify({ ...SUCCESS_PAYLOAD, amount: 1 }))
    await expect(verifyWebhookSignature(tampered, sig, SECRET))
      .rejects.toBeInstanceOf(WebhookSignatureError)
  })

  it('rejects a missing signature header', async () => {
    await expect(verifyWebhookSignature(bytes('{}'), null, SECRET))
      .rejects.toMatchObject({ reason: 'missing_signature' })
    await expect(verifyWebhookSignature(bytes('{}'), '', SECRET))
      .rejects.toMatchObject({ reason: 'missing_signature' })
  })

  it('rejects a signature without the sha256= prefix', async () => {
    await expect(verifyWebhookSignature(bytes('{}'), 'deadbeef', SECRET))
      .rejects.toMatchObject({ reason: 'malformed_signature' })
  })

  it('refuses to verify when no secret is configured', async () => {
    // Failing closed is essential: an unconfigured webhook must process nothing
    // rather than accept everything.
    const sig = await computeSignature(bytes('{}'), SECRET)
    await expect(verifyWebhookSignature(bytes('{}'), sig, ''))
      .rejects.toMatchObject({ reason: 'secret_not_configured' })
  })

  it('reads the header from a request without knowing the casing', async () => {
    const body = bytes(JSON.stringify(SUCCESS_PAYLOAD))
    const sig = await computeSignature(body, SECRET)
    const headers = new Headers({ [SIGNATURE_HEADER]: sig })
    await expect(verifyWebhookRequest(headers, body, SECRET)).resolves.toBeUndefined()
  })
})

describe('isSuccessfulPayment', () => {
  it('accepts a documented success event with code 0', () => {
    expect(isSuccessfulPayment(SUCCESS_PAYLOAD)).toBe(true)
  })

  it('rejects an initiation acknowledgement that happens to carry code 0', () => {
    // ResponseCode 0 alone also appears on STK initiation. Without the event
    // name check, an un-paid prompt would activate service.
    expect(isSuccessfulPayment({ ResponseCode: 0 } as HashBackWebhookPayload)).toBe(false)
  })

  it('rejects a failure event', () => {
    expect(isSuccessfulPayment({ event: 'payment.success', ResponseCode: 1 })).toBe(false)
    expect(isSuccessfulPayment({ event: 'payment.failed', ResponseCode: 0 })).toBe(false)
  })

  it('accepts a string response code, since JSON may carry it either way', () => {
    expect(isSuccessfulPayment({ event: 'payment.success', ResponseCode: '0' })).toBe(true)
  })
})

describe('readSettlementFields', () => {
  it('reads a numeric Msisdn from the documented payload', () => {
    // The published example carries Msisdn as a JSON *number* (254701234567),
    // not a string. Reading it as a string alone would silently drop the payer
    // phone on every real webhook, so the number form must be accepted too.
    // A 12-digit integer is well inside the safe-integer range, so String() is
    // exact here.
    const fields = readSettlementFields(SUCCESS_PAYLOAD)
    expect(fields.msisdn).toBe('254701234567')
  })

  it('reads every documented field', () => {
    expect(readSettlementFields(SUCCESS_PAYLOAD)).toEqual({
      accountId: 'HP56',
      transactionId: 'UEC496402X',
      receipt: 'UEC496402X',
      reference: 'HPL1XBF0',
      checkoutId: 'ws_CO_12052026084940776662',
      merchantRequestId: 'ws_CO_12052026084940',
      msisdn: '254701234567',
      amount: 1,
    })
  })

  it('returns nulls rather than undefined for absent fields', () => {
    // null is distinguishable from a real empty value, so the payment service
    // can treat "no AccountID" as a routing failure rather than routing to ''.
    const fields = readSettlementFields({ event: 'payment.success' })
    expect(fields.accountId).toBeNull()
    expect(fields.transactionId).toBeNull()
    expect(fields.amount).toBeNull()
  })

  it('coerces a string amount', () => {
    expect(readSettlementFields({ TransactionAmount: '499' }).amount).toBe(499)
  })

  it('leaves a non-numeric amount null rather than producing NaN', () => {
    expect(readSettlementFields({ TransactionAmount: 'not a number' }).amount).toBeNull()
  })
})