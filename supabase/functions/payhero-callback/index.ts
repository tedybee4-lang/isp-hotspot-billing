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
 * The documented STK call takes `external_reference`, so that is the field this
 * expects; the others are tolerated because a provider is free to echo the
 * reference under a different name and refusing to recognise a real payment over a
 * field name is a worse failure than accepting an extra key. None of these values
 * is treated as proof of anything.
 */
function readReference(body: Record<string, unknown>): string | null {
  const candidates = [
    body.external_reference,
    body.ExternalReference,
    body.reference,
    body.Reference,
    body.account_reference,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
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
    // Nothing actionable. Logged without the body, which may carry customer data.
    console.warn('payhero-callback: no reference in payload')
    return json({ ok: false, settled: false, reason: 'missing_reference' }, 200)
  }

  try {
    const service = new PaymentGatewayService({ admin })
    // The reference is the ONLY thing taken from the payload. Everything that
    // decides the outcome comes back from PayHero's transaction-status endpoint.
    const result = await service.verifyPayHeroPayment({ reference })

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