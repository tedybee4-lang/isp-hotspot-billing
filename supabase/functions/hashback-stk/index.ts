// =============================================================================
//  HashBack STK initiation — Supabase Edge Function.
//
//  Starts an M-Pesa prompt through HashBack on behalf of an authenticated user.
//
//  JWT verification is ON here (unlike the webhook), because this endpoint is
//  called from the panel by a signed-in staff member or customer.
//
//  What this endpoint deliberately does NOT accept:
//    * an amount          — the server resolves it from the invoice or plan
//    * an ISP id          — the server resolves it from the caller's profile
//    * an AccountID       — the server resolves it from the tenant's channel
//    * an API key         — it is decrypted server-side and never leaves
//
//  A successful response means a prompt was accepted for processing. It does NOT
//  mean the customer has paid, and this function never activates anything.
//
//  Deploy:  supabase functions deploy hashback-stk
// =============================================================================

import {
  PaymentGatewayService,
  PaymentServiceError,
  isPaymentServiceError,
} from '../_shared/payment-service.ts'
import { adminFromEnv } from '../_shared/hashback-credentials.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/** Maps a service error to an HTTP status the browser can act on. */
function statusFor(err: PaymentServiceError): number {
  switch (err.code) {
    case 'unauthorized':
      return 401   // the caller's session is bad; retrying will not help
    case 'not_configured':
    case 'not_connected':
      return 503   // nothing the caller can fix; the platform must configure it
    case 'invalid_phone':
      return 400   // the caller's input is wrong
    case 'unknown_account':
    case 'unknown_reference':
    case 'conflict':
      return 409   // state changed underneath us; retry may work
    case 'provider_unavailable':
      return 502
    default:
      return 500
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = await adminFromEnv()
  if (!admin) {
    console.error('hashback-stk: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  // ── Authenticate ──────────────────────────────────────────────────────────
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Missing bearer token' }, 401)

  let body: { phone?: string; invoiceId?: string; clientId?: string; planId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  const service = new PaymentGatewayService({ admin })

  try {
    const result = await service.startPayment(token, {
      // Passed through unvalidated on purpose: the service authenticates the
      // session first, then checks the phone. Checking it here instead meant an
      // anonymous caller received a validation message from a payment endpoint.
      phone: body.phone,
      invoiceId: body.invoiceId ?? null,
      clientId: body.clientId ?? null,
      planId: body.planId ?? null,
    })

    // A provider refusal is a 502: the request was valid, the provider declined.
    // The payment row exists and is pending, which is the correct state.
    if (!result.promptSent) {
      return json({
        ok: false,
        error: result.message,
        paymentId: result.paymentId,
        reference: result.reference,
      }, 502)
    }

    // Explicitly says "pending", so no caller can read this as a receipt.
    return json({
      ok: true,
      status: 'pending',
      message: result.message,
      paymentId: result.paymentId,
      reference: result.reference,
      amount: result.amount,
      currency: result.currency,
      checkoutRequestId: result.checkoutId,
    }, 200)
  } catch (err) {
    if (isPaymentServiceError(err)) {
      return json({ error: err.message, code: err.code }, statusFor(err))
    }
    // Provider errors carry no secret, but the message is still not echoed
    // verbatim to a browser in case a provider ever reflects input back.
    console.error('hashback-stk: initiation failed')
    return json({ error: 'Could not start the payment. Try again shortly.' }, 502)
  }
})