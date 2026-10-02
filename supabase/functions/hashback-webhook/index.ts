// =============================================================================
//  HashBack webhook — Supabase Edge Function.
//
//  Receives STK payment results from HashBack and applies them.
//
//  The order of operations below is the security property of this file, and it
//  is not negotiable:
//
//      RAW BODY
//        ↓
//      X-Hashpay-Signature
//        ↓
//      HMAC-SHA256 verified (timing-safe)
//        ↓  ── 401 on failure, before any JSON is parsed
//      parse JSON
//        ↓
//      route by AccountID → tenant
//        ↓
//      resolve payment reference
//        ↓
//      idempotency check
//        ↓
//      settle (activates once) / fail / queue for reconciliation
//        ↓
//      2xx
//
//  In particular there is no `await req.json()` anywhere above the signature
//  check, because reading the body consumes it and re-serialising it for the
//  HMAC would produce different bytes. HashBack signs the exact bytes sent.
//
//  Deploy:  supabase functions deploy hashback-webhook --no-verify-jwt
//           (JWT verification is off because HashBack authenticates with the
//            HMAC signature, not with a Supabase session.)
// =============================================================================

import {
  verifyWebhookRequest,
  WebhookSignatureError,
  type HashBackWebhookPayload,
} from '../_shared/hashback-webhook.ts'
import { PaymentGatewayService, isPaymentServiceError } from '../_shared/payment-service.ts'
import { adminFromEnv, resolvePlatformCredentials } from '../_shared/hashback-credentials.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-hashpay-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // HashBack posts JSON; anything else is not a delivery we can serve.
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const admin = await adminFromEnv()
  if (!admin) {
    // Misconfiguration, not a bad request. 500 so HashBack retries later.
    console.error('hashback-webhook: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  // ── 1. RAW BODY ────────────────────────────────────────────────────────────
  // Read once, as bytes. Everything downstream uses this exact buffer.
  const rawBody = new Uint8Array(await req.arrayBuffer())

  // ── 2 + 3. READ AND VERIFY THE SIGNATURE ──────────────────────────────────
  //
  // The secret is the platform-wide one from the portal's global webhook.
  // It is decrypted server-side and never appears in a response or a log.
  let secret: string | null
  try {
    const creds = await resolvePlatformCredentials(admin)
    secret = creds?.webhookSecret ?? null
  } catch {
    console.error('hashback-webhook: could not load the webhook secret')
    return json({ error: 'Server not configured' }, 500)
  }

  try {
    await verifyWebhookRequest(req.headers, rawBody, secret ?? '')
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      // The reason is logged for the operator but not echoed to the caller, so
      // an attacker learns only that the request failed.
      console.warn(`hashback-webhook: rejected (${err.reason})`)
      // 401 with no processing. Nothing was parsed, nothing was applied.
      return json({ error: 'Invalid signature' }, 401)
    }
    console.error('hashback-webhook: signature check failed unexpectedly')
    return json({ error: 'Invalid signature' }, 401)
  }

  // ── 4. PARSE — only now, after the signature is proven ────────────────────
  let payload: HashBackWebhookPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    // Signed but not JSON: a provider bug or a misconfigured endpoint.
    return json({ error: 'Malformed payload' }, 400)
  }

  if (typeof payload !== 'object' || payload === null) {
    return json({ error: 'Malformed payload' }, 400)
  }

  // ── 5-8. VALIDATE, ROUTE, SETTLE ──────────────────────────────────────────
  const service = new PaymentGatewayService({ admin })

  try {
    const result = await service.processWebhookEvent(payload)

    // An unroutable event is acknowledged so HashBack stops retrying it, but the
    // outcome is recorded for reconciliation. Answering non-2xx here would cause
    // an endless retry loop for an event we will never be able to apply.
    if (result.reason === 'unknown_account' || result.reason === 'unknown_reference') {
      console.warn(`hashback-webhook: ${result.reason}; queued for reconciliation`)
      return json({ received: true, applied: false, reason: result.reason }, 200)
    }

    if (result.duplicate) {
      // Already applied. 200 so the provider stops retrying, and reported as a
      // duplicate so the log shows no second settlement happened.
      return json({ received: true, applied: false, duplicate: true }, 200)
    }

    return json({
      received: true,
      applied: result.settled,
      activated: result.activated,
    }, 200)
  } catch (err) {
    if (isPaymentServiceError(err)) {
      // A business-level refusal (bad reference, conflict). Not retryable.
      console.error(`hashback-webhook: ${err.code} — ${err.message}`)
      return json({ received: true, applied: false, reason: err.code }, 200)
    }
    // Anything unexpected: 500 so HashBack retries. The payment row is still
    // pending, so a retry settles it rather than losing it.
    console.error('hashback-webhook: processing failed')
    return json({ error: 'Could not process the event' }, 500)
  }
})