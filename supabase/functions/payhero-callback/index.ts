// =============================================================================
//  PayHero callback — Supabase Edge Function.
//
//  Receives PayHero's per-request callback and, CRUCIALLY, verifies the
//  transaction with PayHero before anything is settled.
//
//  WHY NOTHING HERE IS TRUSTED
//  ---------------------------
//  PayHero documents NO webhook signature: no HMAC key, no shared secret, no
//  timestamped digest. There is therefore nothing in this request that proves the
//  sender is PayHero. A body asserting `{"status":"Success"}` could have been
//  written by anyone who learned a reference.
//
//  So the payload is treated as a HINT, never as evidence. The only thing this
//  endpoint extracts from the body is the reference; the truth is then re-read
//  from PayHero's own credentialed transaction-status endpoint. A forged
//  "payment successful" callback activates nothing, because it is never believed.
//
//  Returning 200 immediately and verifying inline would risk PayHero timing out
//  and retrying, so the reply is deliberately short and the work is done inline
//  but tolerantly: any failure still returns 200, because a 5xx would make PayHero
//  hammer an endpoint that cannot fix the underlying problem. Genuinely unmatched
//  references are recorded for a human instead.
// =============================================================================

import { adminFromEnv } from '../_shared/hashback-credentials.ts'
import { PaymentGatewayService } from '../_shared/payment-service.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/**
 * Pulls the reference out of whatever shape PayHero sent.
 *
 * THE PAYLOAD IS NESTED, AND THAT IS THE WHOLE POINT
 * ----------------------------------------------------
 * PayHero's documented callback body is:
 *
 *   { "forward_url": "",
 *     "response": { "Amount": 10,
 *                  "CheckoutRequestID": "ws_CO_...",
 *                  "ExternalReference": "INV-009",
 *                  "MerchantRequestID": "...",
 *                  "MpesaReceiptNumber": "SAE3YULR0Y",
 *                  "Phone": "+254709099876",
 *                  "ResultCode": 0, "ResultDesc": "...", "Status": "Success" },
 *     "status": true }
 *
 * The reference is NOT at the top level. An earlier version of this file only ever
 * looked at top-level keys, so every genuine PayHero callback fell through to
 * `missing_reference`, returned 200, and the payment stayed `pending` forever while
 * the customer had already paid. The `response` object is therefore searched FIRST
 * and the legacy top-level shapes are still tolerated behind it, because a provider
 * is free to change a field name and refusing to recognise a real payment over one
 * is the worse failure.
 *
 * NONE of these values is treated as proof of anything. The reference only selects
 * which internal payment to re-check; PayHero's own credentialed answer decides.
 */
function readReference(body: Record<string, unknown>): string | null {
  const nested =
    body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>)
      : null

  const candidates = [
    // Documented shape.
    nested?.ExternalReference,
    nested?.external_reference,
    // Flattened / legacy shapes, tolerated.
    body.ExternalReference,
    body.external_reference,
    body.reference,
    body.Reference,
    body.account_reference,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Reads the provider identifiers from a callback, as HINTS only.
 *
 * These narrow the PayHero lookup — PayHero resolves transaction-status by any of
 * its own identifiers, so handing it the M-Pesa receipt is far more likely to hit
 * than handing it our reference. They are never used to decide success, and they
 * are never written to the payment on the strength of this request alone.
 */
function readProviderHints(
  body: Record<string, unknown>,
): { receipt: string | null; checkoutRequestId: string | null } {
  const nested =
    body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>)
      : {}

  const firstString = (...values: unknown[]): string | null => {
    for (const v of values) {
      if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    }
    return null
  }

  return {
    receipt: firstString(
      nested.MpesaReceiptNumber,
      nested.mpesa_receipt_number,
      body.MpesaReceiptNumber,
    ),
    checkoutRequestId: firstString(
      nested.CheckoutRequestID,
      nested.checkout_request_id,
      body.CheckoutRequestID,
    ),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = await adminFromEnv()
  if (!admin) {
    console.error('payhero-callback: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    body = (parsed ?? {}) as Record<string, unknown>
  } catch {
    // A malformed body carries no reference, so there is nothing to verify.
    return json({ ok: false, settled: false, reason: 'malformed_body' }, 200)
  }

  const reference = readReference(body)
  if (!reference) {
    // Nothing actionable. Logged WITHOUT the body: it carries the payer's phone
    // number, and this log is retained. The key names seen are logged instead,
    // because "the shape was wrong" is exactly what must be diagnosable.
    console.warn(
      'payhero-callback: no reference in payload',
      JSON.stringify({ keys: Object.keys(body) }),
    )
    return json({ ok: false, settled: false, reason: 'missing_reference' }, 200)
  }

  const hints = readProviderHints(body)

  // Structured, non-secret diagnostics. Enough to answer "did the callback arrive,
  // which payment did it match, and what happened" without logging a credential,
  // a token, or the payer's phone number.
  console.log(
    'payhero-callback: received',
    JSON.stringify({
      reference,
      hasReceiptHint: hints.receipt !== null,
      hasCheckoutHint: hints.checkoutRequestId !== null,
    }),
  )

  try {
    const service = new PaymentGatewayService({ admin })
    // The reference is the ONLY thing taken from the payload. Everything that
    // decides the outcome comes back from PayHero's transaction-status endpoint.
    // The provider identifiers are passed as LOOKUP HINTS only, so PayHero is
    // asked the question its own index can answer fastest.
    const result = await service.verifyPayHeroPayment({
      reference,
      receiptHint: hints.receipt,
      checkoutRequestIdHint: hints.checkoutRequestId,
    })

    console.log(
      'payhero-callback: processed',
      JSON.stringify({
        reference,
        ispId: result.ispId ?? null,
        settled: result.settled,
        duplicate: result.duplicate,
        activated: result.activated,
        reason: result.reason ?? null,
      }),
    )

    if (result.settled || result.duplicate || result.activated) {
      await admin.from('audit_logs').insert({
        actor_role: 'super_admin',
        isp_id: result.ispId ?? null,
        action: 'payment:payhero-callback-settled',
        target_type: 'payment',
        // The reference is our own opaque id, not a credential.
        target_id: reference,
        metadata: {
          settled: result.settled,
          duplicate: result.duplicate,
          activated: result.activated,
          provider: 'payhero',
        },
      })
    }

    // 200 in every settled-or-not case: PayHero has nothing to fix by retrying.
    return json({
      ok: result.ok,
      settled: result.settled,
      duplicate: result.duplicate,
      reason: result.reason ?? null,
    }, 200)
  } catch {
    // Never echo an internal message that might quote a credential.
    console.error('payhero-callback: verification failed')
    return json({ ok: false, settled: false, reason: 'verification_error' }, 200)
  }
})