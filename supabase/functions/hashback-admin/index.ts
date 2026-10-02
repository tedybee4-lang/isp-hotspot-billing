// =============================================================================
//  Platform HashBack administration — Supabase Edge Function.
//
//  Super-admin only. Handles three operations that must never run in a browser:
//  storing credentials, reading connection status, and verifying connectivity
//  with the live provider.
//
//  What this endpoint guarantees about secrets:
//
//    * An API key or webhook secret arrives in the request body, is encrypted
//      immediately, and is never written anywhere in plaintext.
//    * No response, ever, contains a stored secret or its ciphertext. Responses
//      carry booleans (`has_api_key`) and provider-reported status only.
//    * `getPlatformCredentialStatus` reads the row WITHOUT decrypting, so
//      simply viewing this screen never puts a key in memory on the server.
//    * Authorization is checked server-side against the caller's own profile.
//      The route is inside the super-admin guard in the UI as well, but that is
//      only a convenience — this function does not rely on it.
//
//  Deploy:  supabase functions deploy hashback-admin
// =============================================================================

import {
  adminFromEnv,
  getPlatformCredentialStatus,
  storePlatformCredentials,
} from '../_shared/hashback-credentials.ts'
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
    console.error('hashback-admin: SUPABASE_URL or service key missing')
    return json({ error: 'Server not configured' }, 500)
  }

  // ── Authenticate ──────────────────────────────────────────────────────────
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Missing bearer token' }, 401)

  const { data: userData, error: userErr } = await admin.auth.getUser(token)
  if (userErr || !userData?.user) {
    return json({ error: 'Invalid or expired session' }, 401)
  }

  // ── Authorize: super admin only ───────────────────────────────────────────
  //
  // Checked here rather than trusting the route guard. A tenant admin calling
  // this endpoint directly must be refused, because storing a platform-wide
  // credential is not a tenant capability.
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  const role = (profile as { role?: string } | null)?.role
  if (role !== 'super_admin') {
    return json({ error: 'Only a platform administrator can do that.' }, 403)
  }

  let body: {
    action?: 'status' | 'save' | 'verify'
    apiKey?: string
    webhookSecret?: string
    webhookUrl?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  const action = body.action ?? 'status'

  try {
    if (action === 'status') {
      // Reads the row without decrypting: nothing secret is loaded.
      return json({ ok: true, status: await getPlatformCredentialStatus(admin) })
    }

    if (action === 'save') {
      // An empty field means "leave unchanged", not "clear", so a form that
      // submits one masked input cannot wipe a working configuration.
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const webhookSecret =
        typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : ''

      if (!apiKey && !webhookSecret && !body.webhookUrl) {
        return json({
          error: 'Enter an API key, a webhook secret, or a webhook URL.',
        }, 400)
      }

      const status = await storePlatformCredentials(admin, {
        apiKey,
        webhookSecret,
        webhookUrl: body.webhookUrl,
      })

      await admin.from('audit_logs').insert({
        actor_id: userData.user.id,
        actor_role: 'super_admin',
        action: 'payment:hashback-credentials-updated',
        target_type: 'platform_payment_config',
        // Records THAT a change happened, never what was in it.
        metadata: {
          api_key_changed: apiKey !== '',
          webhook_secret_changed: webhookSecret !== '',
        },
      })

      // Returns booleans only. No ciphertext, no key.
      return json({ ok: true, status })
    }

    if (action === 'verify') {
      const service = new PaymentGatewayService({ admin })

      try {
        const result = await service.verifyPlatformConnection()

        await admin.from('audit_logs').insert({
          actor_id: userData.user.id,
          actor_role: 'super_admin',
          action: 'payment:hashback-verified',
          target_type: 'platform_payment_config',
          metadata: {
            api_available: result.apiAvailable,
            partner_access: result.partnerAccess,
            token_balance: result.tokenBalance,
            linked_channels: result.linkedChannels,
          },
        })

        return json({
          ok: result.apiAvailable,
          apiAvailable: result.apiAvailable,
          partnerAccess: result.partnerAccess,
          tokenBalance: result.tokenBalance,
          linkedChannels: result.linkedChannels,
          lastError: result.lastError,
          detail: result.detail,
          status: await getPlatformCredentialStatus(admin),
        })
      } catch (err) {
        // "Not configured" is a real, common state here, not a crash.
        const message = err instanceof Error ? err.message : 'Verification failed.'
        return json({
          ok: false,
          error: message,
          status: await getPlatformCredentialStatus(admin),
        }, 400)
      }
    }

    return json({ error: 'Unknown action' }, 400)
  } catch {
    // Never echo an internal message that might quote a secret. The audit trail
    // and the status endpoint carry the diagnosis.
    console.error('hashback-admin: request failed')
    return json({ error: 'The request could not be completed.' }, 500)
  }
})