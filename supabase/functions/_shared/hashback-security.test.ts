/**
 * HashBack security regression tests.
 *
 * These cover the failure modes that would each be a live vulnerability, and
 * each one is asserted against the real module rather than a description of it.
 * The recurring theme is that a secret must never leave the server, and that a
 * webhook must never be trusted before its signature is proven.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  verifyWebhookRequest,
  computeSignature,
  WebhookSignatureError,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  isSuccessfulPayment,
  readSettlementFields,
  type HashBackWebhookPayload,
} from './hashback-webhook.ts'
import { getPlatformCredentialStatus } from './hashback-credentials.ts'

const SECRET = 'whsec_test_only_not_a_real_value'
const BODY = JSON.stringify({
  event: 'payment.success',
  ResponseCode: 0,
  CheckoutRequestID: 'ws_CO_1',
  AccountID: 'HP-isp-a',
  Msisdn: 254700000001,
  TransactionAmount: 100,
})

function headers(sig: string | null): Headers {
  const h = new Headers()
  if (sig !== null) h.set(SIGNATURE_HEADER, sig)
  return h
}

describe('HashBack webhook signature verification', () => {
  it('accepts a valid signature', async () => {
    const sig = await computeSignature(BODY, SECRET)
    await expect(
      verifyWebhookRequest(headers(sig), BODY, SECRET),
    ).resolves.toBeUndefined()
  })

  it('rejects a missing signature', async () => {
    await expect(
      verifyWebhookRequest(headers(null), BODY, SECRET),
    ).rejects.toThrow(WebhookSignatureError)
  })

  it('rejects a malformed signature', async () => {
    await expect(
      verifyWebhookRequest(headers('not-a-signature'), BODY, SECRET),
    ).rejects.toThrow(WebhookSignatureError)
  })

  it('rejects a signature computed with the wrong secret', async () => {
    const sig = await computeSignature(BODY, 'a-different-secret')
    await expect(
      verifyWebhookRequest(headers(sig), BODY, SECRET),
    ).rejects.toThrow(WebhookSignatureError)
  })

  it('rejects a signature computed over different bytes', async () => {
    // This is the property that "parse then verify" would break: the HMAC is
    // over the RAW body, so any whitespace or re-serialisation difference fails.
    const sig = await computeSignature(BODY, SECRET)
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2)
    await expect(
      verifyWebhookRequest(headers(sig), reserialised, SECRET),
    ).rejects.toThrow(WebhookSignatureError)
  })

  it('never echoes the secret in its error', async () => {
    const sig = await computeSignature(BODY, 'wrong-secret-value')
    try {
      await verifyWebhookRequest(headers(sig), BODY, SECRET)
      throw new Error('should have rejected')
    } catch (err) {
      const text = (err as Error).message
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('wrong-secret-value')
    }
  })

  it('refuses outright when no secret is configured', async () => {
    const sig = await computeSignature(BODY, SECRET)
    const err = await verifyWebhookRequest(headers(sig), BODY, '')
      .then(() => null, (e) => e as WebhookSignatureError)
    expect(err).toBeInstanceOf(WebhookSignatureError)
    expect(err?.reason).toBe('secret_not_configured')
  })
})
describe('only a settled payment counts as paid', () => {
  it('requires both the success event name and ResponseCode 0', () => {
    const base: HashBackWebhookPayload = { ResponseCode: 0 }
    expect(isSuccessfulPayment({ ...base, event: 'payment.success' })).toBe(true)
    // ResponseCode 0 alone also appears on INITIATION acknowledgements.
    // Treating that as paid activates service for a prompt nobody entered a
    // PIN for, which is the whole reason both conditions are required.
    expect(isSuccessfulPayment(base)).toBe(false)
    expect(isSuccessfulPayment({ event: 'payment.success', ResponseCode: 1 }))
      .toBe(false)
    expect(isSuccessfulPayment({ event: 'payment.failed', ResponseCode: 0 }))
      .toBe(false)
  })

  it('treats a numeric ResponseCode as its string form', () => {
    expect(isSuccessfulPayment({ event: 'payment.success', ResponseCode: '0' }))
      .toBe(true)
  })

  it('never activates on a non-success event', () => {
    expect(isSuccessfulPayment({
      event: 'payment.success', ResponseCode: 1, CheckoutRequestID: 'ws_1',
    })).toBe(false)
  })
})

describe('settlement fields carry the tenant routing', () => {
  it('reads the AccountID that decides which ISP is credited', () => {
    const f = readSettlementFields({
      event: 'payment.success', ResponseCode: 0,
      CheckoutRequestID: 'ws_CO_1', AccountID: 'HP-isp-a',
      TransactionAmount: 100, Msisdn: 254700000001,
    })
    expect(f.accountId).toBe('HP-isp-a')
    expect(f.checkoutId).toBe('ws_CO_1')
    expect(f.amount).toBe(100)
    // The documented example carries Msisdn as a JSON number.
    expect(f.msisdn).toBe('254700000001')
  })

  it('reports a missing AccountID as null rather than a wrong tenant', () => {
    const f = readSettlementFields({ event: 'payment.success', ResponseCode: 0 })
    expect(f.accountId).toBeNull()
  })
})

describe('the platform credential status never carries the credential', () => {
  it('returns only booleans and provider metadata', async () => {
    const row = {
      hashback_api_key_encrypted: 'v1.iv.ciphertext',
      hashback_webhook_secret_encrypted: 'v1.iv.ciphertext',
      hashback_connection_status: 'verified',
      hashback_webhook_url: 'https://example.invalid/hook',
    }
    const fake = {
      // Mirrors the real chain exactly: from().select(COLUMNS).eq('id', true)
      // .maybeSingle(). The .eq() is deliberately NOT optional - if the read
      // ever stopped scoping to the single platform row, this fake would break.
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as never

    const status = await getPlatformCredentialStatus(fake)

    // Presence, not value.
    expect(status.hasApiKey).toBe(true)
    expect(status.hasWebhookSecret).toBe(true)
    expect(status.connectionStatus).toBe('verified')

    // The serialized form must not contain either secret in any form.
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('v1.iv.ciphertext')
    expect(serialized).not.toMatch(/ciphertext/i)
  })
})