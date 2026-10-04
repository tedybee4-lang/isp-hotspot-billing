// =============================================================================
//  payhero-provision — Supabase Edge Function.
//
//  Turns an ISP's Till number into a PayHero payment channel, automatically.
//
//  WHY THIS IS A SEPARATE FUNCTION
//  ------------------------------
//  Channel registration needs the platform PayHero credential, which is a
//  long-lived account-wide secret held as AES-GCM ciphertext in
//  platform_payment_config and readable only by the service role. A browser must
//  never hold it, and the existing `save_till_settings` RPC runs in Postgres with
//  no access to it. So the browser asks HERE, this function does the provider
//  call with the service role, and only non-secret channel state goes back.
//
//  WHAT THE CALLER MAY NAME
//  ------------------------
//  The caller supplies a Till number and nothing else that matters. The ISP is
//  resolved from the caller's OWN profile row, so `isp_id` is never a parameter
//  the browser controls: ISP A cannot provision against ISP B, cannot see ISP B's
//  channel, and cannot disconnect it.
//
//  Deploy:  supabase functions deploy payhero-provision
// =============================================================================

import { adminFromEnv } from '../_shared/hashback-credentials.ts'
import { PaymentGatewayService } from '../_shared/payment-service.ts'

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
    console.error('payhero-provision: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  // ── Authenticate BEFORE reading the body ─────────────────────────────────
  // An unauthenticated caller gets an identical 401 whatever it sends, so this
  // endpoint's internals stay unmapped to someone holding only the public anon key.
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Sign in to continue.' }, 401)

  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData?.user) {
    return json({ error: 'Your session has expired. Sign in again.' }, 401)
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('isp_id, role')
    .eq('id', userData.user.id)
    .maybeSingle()

  const tenant = profile as { isp_id?: string | null; role?: string | null } | null
  const ispId = tenant?.isp_id

  // A platform admin with no tenant of their own has no Till to provision, so
  // this is refused rather than silently provisioning for nobody.
  if (!ispId) {
    return json(
      { error: 'Only an ISP account can set up a payment channel.' },
      403,
    )
  }

  let body: { shortCode?: string; accountNumber?: string | null; description?: string | null }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  const shortCode = typeof body.shortCode === 'string' ? body.shortCode.trim() : ''
  if (!shortCode) {
    return json({ error: 'Enter your Till Number first.', code: 'missing_till' }, 400)
  }

  try {
    const service = new PaymentGatewayService({ admin })
    const result = await service.provisionPayHeroChannel({
      ispId,
      shortCode,
      accountNumber: body.accountNumber ?? null,
      description: body.description ?? null,
    })

    console.log(
      'payhero-provision: result',
      JSON.stringify({
        ispId,
        status: result.status,
        channelId: result.channelId,
        created: result.created,
        code: result.code ?? null,
      }),
    )

    // READY is only ever reported from a real provider result, and the message is
    // the safe sentence the service composed. No credential, no provider text.
    return json(
      {
        ok: result.ok,
        status: result.status,
        channelId: result.channelId,
        created: result.created,
        message: result.message,
        code: result.code ?? null,
      },
      // A failed provisioning is a normal, expected outcome, not a server fault:
      // the ISP needs to read the message and retry, so it is a 422 with detail
      // rather than a 500 that looks like the platform is broken.
      result.ok ? 200 : 422,
    )
  } catch (err) {
    // Never echo an internal message that might quote a credential.
    console.error('payhero-provision: provisioning error')
    return json(
      {
        ok: false,
        status: 'failed',
        message: 'Payment channel setup failed. Please try again shortly.',
        code: 'provisioning_error',
      },
      500,
    )
  }
})