// =============================================================================
//  portal-stk - Supabase Edge Function.
//
//  Starts an M-Pesa prompt for a customer standing on a captive portal.
//
//  WHY THIS EXISTS SEPARATELY FROM `hashback-stk`
//  -----------------------------------------------
//  `hashback-stk` requires a Supabase JWT, because it is called from the panel by
//  a signed-in staff member. A captive-portal visitor is, by definition, not
//  signed in: they have just been redirected here by the router because they
//  have no connectivity, which is also why they cannot sign in. So the only
//  STK entry point the portal had was unreachable for the people who needed it,
//  and packages could be listed but never bought.
//
//  This function is therefore anonymous (JWT verification OFF). That changes
//  what has to be true before any money moves, so it is worth being explicit
//  about the design:
//
//    1. The caller supplies a SLUG, a PLAN ID and a PHONE NUMBER. Nothing else.
//       No amount, no ISP id, no AccountID, no credential of any kind is
//       accepted, because there is no parameter that could carry one.
//
//    2. `portal_create_payment` resolves the tenant from the slug, reads the
//       price from the plan row, reads the AccountID from that tenant's own
//       channel, and creates the pending payment. It is granted to the service
//       role only. A caller on ISP A's portal cannot name ISP B, because the
//       only thing it can name is a slug, and the slug decides everything.
//
//    3. Initiation never settles. The response says PENDING. Nothing is
//       activated here; only a verified provider result does that, through the
//       existing webhook path.
//
//  The residual risk of an anonymous money-moving endpoint is abuse: someone
//  spamming prompts at an ISP's expense. That is bounded by HashBack charging
//  per STK and by the ISP's own channel, and it is the same exposure any
//  public paybill has. It is NOT bounded by trusting the caller.
//
//  AUTHENTICATION: anonymous by design.
//
//  There is no session to check. A captive-portal visitor reached this page
//  because their router found them offline, so they cannot have signed in and
//  cannot be asked to. Authentication is therefore replaced by authorisation-by-
//  construction: the caller may name only a slug, a package and a phone number,
//  and the tenant, the price and the payment destination are all resolved from
//  the database in `portal_create_payment` (service role only). Nothing that
//  identifies an account, a tenant or an amount is accepted.
//
//  Deploy:  supabase functions deploy portal-stk --no-verify-jwt
// =============================================================================

import { HashBackClient, normaliseMsisdn } from '../_shared/hashback.ts'
import { PayHeroClient } from '../_shared/payhero.ts'
import {
  adminFromEnv,
  resolvePlatformCredentials,
} from '../_shared/hashback-credentials.ts'
import { resolvePayHeroCredentials } from '../_shared/payhero-credentials.ts'

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

/** The message a caller sees for each way this can legitimately fail. */
const MESSAGES: Record<string, string> = {
  invalid_phone: 'Enter a valid Kenyan phone number, for example 0712345678.',
  unknown_plan: 'That package is no longer available. Please choose another.',
  not_configured: 'Payments are not available on this network right now.',
  portal_not_accepting: 'This network is not accepting online payments right now.',
}

/** Maps a database error to a customer-actionable code and HTTP status. */
function classify(text: string): { code: string; status: number } {
  if (/phone number/i.test(text)) return { code: 'invalid_phone', status: 400 }
  if (/Package not found/i.test(text)) return { code: 'unknown_plan', status: 404 }
  if (/not accepting payments/i.test(text)) {
    return { code: 'portal_not_accepting', status: 503 }
  }
  if (/no valid price|not ready to accept/i.test(text)) {
    return { code: 'not_configured', status: 503 }
  }
  return { code: 'error', status: 500 }
}

/**
 * The project's own base URL, for building the callback address we hand PayHero.
 *
 * Reads the same environment variable the Supabase client is built from, so there
 * is no second copy of the project's URL to keep in sync. Returns an empty string
 * when it is unset rather than throwing, because the only consequence is a missing
 * callback URL — settlement still works, it just happens on a sweep instead of
 * immediately.
 */
function adminUrl(): string {
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno
  if (deno?.env?.get) return deno.env.get('SUPABASE_URL') ?? ''
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.SUPABASE_URL ?? ''
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = await adminFromEnv()
  if (!admin) {
    console.error('portal-stk: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  let body: { slug?: string; planId?: string; phone?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  // ── Validate the only three things a caller may say ────────────────────────
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  const planId = typeof body.planId === 'string' ? body.planId.trim() : ''

  if (!slug || !planId) {
    return json({ error: 'A portal and a package are required.' }, 400)
  }
  // Shape-checked before it reaches the database, so a nonsense id cannot
  // become a Postgres cast error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(planId)) {
    return json({ error: MESSAGES.unknown_plan, code: 'unknown_plan' }, 404)
  }

  const msisdn = normaliseMsisdn(typeof body.phone === 'string' ? body.phone : '')
  if (!msisdn) {
    return json({ error: MESSAGES.invalid_phone, code: 'invalid_phone' }, 400)
  }

  // ── Resolve tenant, price and AccountID server-side ────────────────────────
  //
  // Everything that decides where the money goes, and how much of it, is
  // determined here, from the database, keyed on the slug.
  const { data, error } = await admin.rpc('portal_create_payment', {
    p_slug: slug,
    p_plan_id: planId,
    p_msisdn: msisdn,
  })

  if (error) {
    // Postgres error text is not echoed to the caller: it can carry row values.
    // Map to something a customer can act on instead.
    const { code, status } = classify(String(error.message ?? ''))
    console.error('portal-stk: could not create payment')
    return json({ error: MESSAGES[code] ?? 'Could not start the payment.', code }, status)
  }

  const charge = data as {
    payment_id: string
    reference: string
    amount: number
    currency: string
    plan_name: string
    hashback_account_id: string
    payhero_channel_id: number | null
    /** Which provider owns this payment. Resolved server-side, never a request field. */
    provider: string
    collection_mode: 'stk' | 'manual_till'
    till_number: string | null
    paybill_number: string | null
    customer_notice: string | null
  }

  // ── Manual Till: hand back instructions, do not prompt ──────────────────────
  //
  // `manual_till` is the product's default and, for most ISPs, its only working
  // collection path. There is no STK here: the customer pays the Till from their
  // own M-Pesa app and staff confirm it with confirm_manual_payment. The payment
  // row and invoice already exist and are pending, exactly as they would be on
  // the automated path, so settlement grants service either way.
  if (charge.collection_mode === 'manual_till') {
    const number = charge.till_number ?? charge.paybill_number
    return json({
      ok: true,
      status: 'pending',
      mode: 'manual_till',
      message: 'Pay the amount below to the Till number, then send us your M-Pesa confirmation code.',
      reference: charge.reference,
      amount: Number(charge.amount),
      currency: charge.currency,
      plan: charge.plan_name,
      till_number: charge.till_number,
      paybill_number: charge.paybill_number,
      notice: charge.customer_notice,
      instructions: number
        ? [
            'Open M-Pesa → Send Money → To Till/Paybill',
            `Send exactly ${charge.currency} ${Number(charge.amount).toLocaleString()} to ${number}`,
            `Use ${charge.reference} as the account name`,
            'Then enter your M-Pesa confirmation code so we can verify it',
          ]
        : [],
    }, 200)
  }

  // ── PayHero: prompt the provider that owns this payment ─────────────────────
  //
  // Mirrors the HashBack branch exactly, against the already-verified PayHero
  // adapter. Nothing about the provider is taken from the request: `charge.provider`
  // comes from the tenant's own configuration row, and the channel id comes from
  // that same row. So a caller on one ISP's portal cannot direct a payment at
  // another's Till even by guessing, because they never supply either value.
  //
  // The response is PENDING either way. A prompt was sent; nobody has paid.
  if (charge.provider === 'payhero') {
    if (charge.payhero_channel_id == null) {
      // The RPC already refuses this case, so reaching here means the config
      // changed between the two calls. Refuse rather than prompt an unknown Till.
      return json({ error: MESSAGES.not_configured, code: 'not_configured' }, 503)
    }

    let creds
    try {
      creds = await resolvePayHeroCredentials(admin)
    } catch {
      console.error('portal-stk: PayHero credentials not configured')
      return json({ error: MESSAGES.not_configured, code: 'not_configured' }, 503)
    }

    try {
      const client = new PayHeroClient({ apiToken: creds.apiToken })
      const result = await client.initiateStk({
        channelId: charge.payhero_channel_id,
        // The authoritative amount, straight from the plan row.
        amount: Number(charge.amount),
        phoneNumber: msisdn,
        externalReference: charge.reference,
        // PayHero posts its callback here, which is what triggers verification.
        callbackUrl: `${adminUrl()}/functions/v1/payhero-callback`,
      })

      // PayHero signals acceptance by returning a reference, not a boolean. An
      // absent reference means the prompt was NOT sent, and telling the customer
      // to look at their phone would be a lie.
      if (!result.accepted || !result.reference) {
        await admin.from('payments')
          .update({ failure_reason: result.message })
          .eq('provider_reference', charge.reference)
        return json({
          ok: false,
          error: 'M-Pesa declined to start this payment. Please try again.',
          code: 'stk_refused',
        }, 502)
      }

      await admin.rpc('record_payhero_stk', {
        p_payment_id: charge.payment_id,
        p_transaction_id: result.reference,
      })

      return json({
        ok: true,
        status: 'pending',
        mode: 'stk',
        provider: 'payhero',
        message: result.message || 'Enter your M-Pesa PIN to complete the payment.',
        reference: charge.reference,
        amount: Number(charge.amount),
        currency: charge.currency,
        plan: charge.plan_name,
      }, 200)
    } catch {
      // Provider unreachable. The payment row exists and is pending, which is the
      // correct state: it can still be settled by a later callback.
      console.error('portal-stk: PayHero STK initiation failed')
      return json({
        error: 'Could not reach M-Pesa. Please try again shortly.',
        code: 'provider_unavailable',
      }, 502)
    }
  }

  // ── Prompt the provider ────────────────────────────────────────────────────
  const creds = await resolvePlatformCredentials(admin)
  if (!creds) {
    console.error('portal-stk: platform HashBack credentials not configured')
    return json({ error: MESSAGES.not_configured, code: 'not_configured' }, 503)
  }

  let init: Awaited<ReturnType<HashBackClient['initiateStk']>>
  try {
    const client = new HashBackClient({ apiKey: creds.apiKey })
    init = await client.initiateStk({
      accountId: charge.hashback_account_id,
      // The authoritative amount, straight from the plan row.
      amount: Number(charge.amount),
      msisdn,
      reference: charge.reference,
    })
  } catch {
    // Provider unreachable. The payment row exists and is pending, which is the
    // correct state: it can still be settled by a later webhook.
    console.error('portal-stk: STK initiation failed')
    return json({
      error: 'Could not reach M-Pesa. Please try again shortly.',
      code: 'provider_unavailable',
    }, 502)
  }

  if (!init.accepted) {
    // The provider refused the prompt. Keep the row pending with the reason so
    // an operator can see it, and tell the customer plainly.
    await admin.from('payments')
      .update({ failure_reason: init.message })
      .eq('provider_reference', charge.reference)

    return json({
      ok: false,
      error: init.message || 'M-Pesa declined to start this payment. Please try again.',
      reference: charge.reference,
    }, 502)
  }

  await admin.rpc('record_hashback_checkout', {
    p_payment_id: charge.payment_id,
    p_checkout_id: init.checkoutId,
    p_merchant_request_id: init.merchantRequestId,
  })

  // Explicitly PENDING. No caller may read this as a receipt: the prompt was
  // sent, not the money received.
  return json({
    ok: true,
    status: 'pending',
    message: init.message || 'Enter your M-Pesa PIN to complete the payment.',
    reference: charge.reference,
    amount: Number(charge.amount),
    currency: charge.currency,
    plan: charge.plan_name,
  }, 200)
})