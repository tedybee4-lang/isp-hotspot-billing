// =============================================================================
//  M-Pesa STK Push — Supabase Edge Function (Deno)
// =============================================================================
//  Daraja credentials live ONLY here (server side) and are resolved per tenant
//  payment mode:
//
//    manual_till    → rejected; the tenant collects at a Till without an API.
//    platform_daraja → the operator's shared keys + this tenant's shortcode.
//    own_daraja      → this tenant's own consumer key/secret/passkey.
//
//  Nothing sensitive ever reaches the browser.
//
//  Deploy:  supabase functions deploy stk-push --no-verify-jwt
//  Invoke:  POST {SUPABASE_URL}/functions/v1/stk-push
//           { "ispId": "<uuid>", "phone": "0712345678",
//             "amount": 500, "invoiceId": "<uuid>" }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DARJAJA_BASE: Record<string, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/** Accepts 0712345678, +254712345678, 254712345678 → 254712345678 */
function normalisePhone(input: string): string | null {
  let digits = input.replace(/[^\d]/g, '')
  if (digits.startsWith('0')) digits = '254' + digits.slice(1)
  if (!/^254\d{9}$/.test(digits)) return null
  return digits
}

async function getAccessToken(base: string, key: string, secret: string) {
  const res = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: {
      Authorization: 'Basic ' + btoa(`${key}:${secret}`),
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Daraja OAuth failed (${res.status})`)
  const data = await res.json()
  return data.access_token as string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    })

    // ── 1. Identify the caller (must be a logged-in staff member) ──────────────
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Missing bearer token' }, 401)

    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData.user) return json({ error: 'Invalid or expired session' }, 401)

    const { data: profile } = await admin
      .from('profiles').select('role, isp_id').eq('id', userData.user.id).single()

    const allowed = ['super_admin', 'isp_owner', 'isp_admin', 'isp_agent']
    if (!profile || !allowed.includes(profile.role)) {
      return json({ error: 'Only ISP staff can initiate payments' }, 403)
    }

    // ── 2. Validate input ─────────────────────────────────────────────────────
    const body = await req.json()

    // The tenant is ALWAYS derived from the caller's own profile. A body
    // `ispId` is accepted only from a super admin, who legitimately operates
    // across tenants; for everyone else it is ignored rather than trusted, so
    // staff cannot push a payment into another ISP's Daraja account.
    const isSuperAdmin = profile.role === 'super_admin'
    const requestedId = typeof body?.ispId === 'string' ? body.ispId : undefined
    const tenantId = isSuperAdmin ? requestedId ?? profile.isp_id : profile.isp_id

    if (requestedId && requestedId !== profile.isp_id && !isSuperAdmin) {
      return json({ error: 'You cannot initiate payments for another ISP' }, 403)
    }
    if (!tenantId) return json({ error: 'No ISP associated with this account' }, 400)

    const msisdn = normalisePhone(String(body?.phone ?? ''))
    if (!msisdn) return json({ error: 'Invalid phone number. Use 07XXXXXXXX.' }, 400)

    const value = Number(body?.amount)
    if (!Number.isFinite(value) || value < 1) {
      return json({ error: 'Amount must be a positive number' }, 400)
    }

    // ── 3. Load this tenant's configuration (service role only) ───────────────
    const { data: cfg, error: cfgErr } = await admin
      .from('isp_payment_configs').select('*').eq('isp_id', tenantId).maybeSingle()

    if (cfgErr) throw new Error(cfgErr.message)

    if (!cfg || (cfg.payment_mode ?? 'manual_till') === 'manual_till') {
      return json({
        error: 'This ISP collects payments manually at a Till number. Start a manual payment instead of an STK push.',
      }, 400)
    }

    let consumerKey = cfg.mpesa_consumer_key as string | null
    let consumerSecret = cfg.mpesa_consumer_secret as string | null
    let passkey = cfg.mpesa_passkey as string | null
    const shortcode = cfg.mpesa_shortcode as string | null

    if (cfg.payment_mode === 'platform_daraja') {
      const { data: platform, error: platErr } = await admin
        .from('platform_payment_config')
        .select('mpesa_passkey, mpesa_consumer_key, mpesa_consumer_secret')
        .eq('id', true).maybeSingle()

      if (platErr || !platform?.mpesa_consumer_key || !platform?.mpesa_passkey) {
        return json({
          error: 'The platform operator has not configured shared M-Pesa credentials yet. Ask them to set it up, or switch this ISP to Manual Till / Own Daraja.',
        }, 400)
      }
      consumerKey = platform.mpesa_consumer_key
      consumerSecret = platform.mpesa_consumer_secret
      passkey = platform.mpesa_passkey
    }

    if (!consumerKey || !consumerSecret) {
      return json({ error: 'M-Pesa consumer key/secret are missing for this ISP.' }, 400)
    }
    if (!passkey) {
      return json({ error: 'The Lipa na M-Pesa Online passkey is missing for this ISP.' }, 400)
    }
    if (!shortcode) {
      return json({ error: 'No Paybill/Till shortcode is configured for this ISP.' }, 400)
    }

    const env = cfg.mpesa_env === 'production' ? 'production' : 'sandbox'
    const base = DARJAJA_BASE[env]

// ── 4. Build the STK request ──────────────────────────────────────────────
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)
    const password = btoa(`${shortcode}${passkey}${timestamp}`)
    const callbackUrl = cfg.callback_url || `${supabaseUrl}/functions/v1/stk-callback`

    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAccessToken(base, consumerKey!, consumerSecret!)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(value),
        PartyA: msisdn,
        PartyB: shortcode,
        PhoneNumber: msisdn,
        CallBackURL: callbackUrl,
        AccountReference: body.accountReference ?? tenantId.slice(0, 12),
        TransactionDesc: body.transactionDesc ?? 'Internet Subscription Payment',
      }),
    })

    const stkData = await stkRes.json()

    if (!stkRes.ok || stkData.ResponseCode !== '0') {
      return json({
        error: stkData.ResponseDescription || 'STK push was rejected by Safaricom',
        code: stkData.ResponseCode ?? stkRes.status,
      }, 502)
    }

    // ── 5. Record the pending payment so the callback can settle it ───────────
    await admin.from('payments').insert({
      isp_id: tenantId,
      client_id: body.clientId ?? null,
      invoice_id: body.invoiceId ?? null,
      phone: msisdn,
      amount: value,
      method: 'mpesa',
      status: 'pending',
      checkout_request_id: stkData.CheckoutRequestID,
    })

    return json({
      success: true,
      message: stkData.CustomerMessage || 'Check your phone and enter your M-Pesa PIN.',
      checkoutRequestId: stkData.CheckoutRequestID,
      merchantRequestId: stkData.MerchantRequestID,
      environment: env,
      usedPlatformCredentials: cfg.payment_mode === 'platform_daraja',
    })
  } catch (err) {
    console.error('stk-push error:', err)
    return json({ error: (err as Error).message ?? 'Unexpected server error' }, 500)
  }
})