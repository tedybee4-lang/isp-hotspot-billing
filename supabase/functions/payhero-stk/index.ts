// =============================================================================
//  PayHero STK — Supabase Edge Function.
//
//  Called by a signed-in ISP admin or the captive portal to push an M-Pesa prompt
//  through PayHero for the caller's OWN tenant.
//
//  WHAT THIS ENDPOINT REFUSES TO DO
//  --------------------------------
//  It accepts no amount, no currency, no channel id and no ISP id. Every one of
//  those is resolved server-side from the authenticated session and the tenant's
//  own plan or invoice row. That is the guarantee that a modified browser request
//  cannot change what a customer is charged.
//
//  A prompt sent is not a payment made. This endpoint returns as soon as PayHero
//  accepts the push; the payment stays PENDING and the customer stays inactive
//  until payhero-callback verifies the transaction with PayHero and settlement
//  runs.
//
//  Deploy:  supabase functions deploy payhero-stk
// =============================================================================

import { adminFromEnv } from '../_shared/hashback-credentials.ts'
import {
  PaymentGatewayService,
  PaymentServiceError,
} from '../_shared/payment-service.ts'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = await adminFromEnv()
  if (!admin) {
    console.error('payhero-stk: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!bearer) return json({ error: 'Missing bearer token' }, 401)

  let body: {
    phone?: string
    invoiceId?: string | null
    clientId?: string | null
    planId?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  // No `amount` is read here, and none is passed on. That is deliberate and is
  // the single most important property of this endpoint.
  const phone = typeof body.phone === 'string' ? body.phone : ''
  if (!phone.trim()) {
    return json({ error: 'Enter a valid Kenyan phone number.', code: 'invalid_phone' }, 400)
  }

  try {
    const service = new PaymentGatewayService({ admin })
    const result = await service.startPayHeroPayment(bearer, {
      phone,
      invoiceId: body.invoiceId ?? null,
      clientId: body.clientId ?? null,
      planId: body.planId ?? null,
      // Tell PayHero where to send its callback, so settlement does not have to
      // wait for a scheduled sweep.
      callbackUrl: `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/payhero-callback`,
    })

    return json({
      ok: result.ok,
      reference: result.reference,
      promptSent: result.promptSent,
      message: result.message,
    })
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      // The service's own codes are safe to return: they describe the tenant's
      // configuration, never a credential.
      const status = err.code === 'unauthorized' ? 401 : err.code === 'conflict' ? 409 : 400
      return json({ error: err.message, code: err.code }, status)
    }
    console.error('payhero-stk: request failed')
    return json({ error: 'The payment could not be started.' }, 500)
  }
})