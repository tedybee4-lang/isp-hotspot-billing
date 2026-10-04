// =============================================================================
//  payhero-reconcile — Supabase Edge Function.
//
//  Recovers payments whose PayHero callback never arrived, or arrived before
//  PayHero had indexed the transaction.
//
//  WHY THIS EXISTS
//  ---------------
//  PayHero posts the callback to `payhero-callback`, and that endpoint answers 200
//  in every case on purpose — a 5xx would make PayHero hammer a URL that cannot
//  fix the underlying problem. The consequence is that a callback which is lost,
//  blocked by a captive-portal network, or delivered a few seconds before PayHero
//  indexed the transaction leaves a payment at `pending` with nobody left to
//  retry it. That is the state customers describe as "I paid and got nothing".
//
//  This sweep is the retry. It does NOT create payments and it does NOT trust its
//  own input: it reads OUR OWN pending PayHero payments and asks PayHero about
//  each one by the reference PayHero issued. A payment can therefore only be
//  settled here if PayHero itself says the money moved.
//
//  SAFE TO CALL REPEATEDLY
//  -----------------------
//  Settlement is idempotent in the database (row lock + duplicate short-circuit +
//  a unique index on the provider transaction id), so running this twice cannot
//  renew a customer twice or add revenue twice.
//
//  Deploy:  supabase functions deploy payhero-reconcile
//  Schedule: attach to Supabase Cron, e.g. every 5 minutes. It also accepts a
//            POST from a super admin, and a GET with a shared secret header for
//            an external scheduler.
// =============================================================================

import { adminFromEnv } from '../_shared/hashback-credentials.ts'
import { PaymentGatewayService } from '../_shared/payment-service.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reconcile-secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const admin = await adminFromEnv()
  if (!admin) {
    console.error('payhero-reconcile: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  // ── Authorisation ─────────────────────────────────────────────────────────
  //
  // This endpoint moves money, so "anyone may call it" is not acceptable. It is
  // reachable by EITHER a signed-in super admin (so an operator can force a sweep)
  // OR a scheduler holding the shared secret. A tenant admin is deliberately NOT
  // allowed: reconciling is platform-wide, not a per-tenant capability.
  const secret = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env?.get('PAYHERO_RECONCILE_SECRET')
  const presented = req.headers.get('x-reconcile-secret')

  let authorised = false
  if (secret && presented && presented === secret) {
    authorised = true
  } else {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
    if (token) {
      const { data: userData } = await admin.auth.getUser(token)
      if (userData?.user) {
        const { data: profile } = await admin
          .from('profiles')
          .select('role')
          .eq('id', userData.user.id)
          .maybeSingle()
        authorised =
          (profile as { role?: string | null } | null)?.role === 'super_admin'
      }
    }
  }

  if (!authorised) {
    return json({ error: 'Not authorised to run reconciliation.' }, 401)
  }

  try {
    const service = new PaymentGatewayService({ admin })
    const summary = await service.reconcilePendingPayHeroPayments({
      // Bounded on purpose: an unbounded sweep would hammer PayHero and could
      // trip their own rate limiting for every other tenant on the account.
      limit: 20,
      olderThanMinutes: 5,
    })
    return json({ ok: true, ...summary })
  } catch {
    console.error('payhero-reconcile: sweep failed')
    return json({ error: 'Reconciliation failed' }, 500)
  }
})