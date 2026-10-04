// =============================================================================
//  Platform PayHero administration — Supabase Edge Function.
//
//  Super-admin only. Handles the operations that must never run in a browser:
//  storing the credential, reading status, verifying against the live API,
//  refreshing discovered channels, assigning a channel to an ISP, and
//  disconnecting.
//
//  WHAT THIS ENDPOINT GUARANTEES ABOUT SECRETS
//
//    * The API token arrives in the request body, is encrypted immediately, and is
//      never written anywhere in plaintext.
//    * NO response, ever, contains the token or its ciphertext. Responses carry
//      `has_api_token` and provider-reported values only.
//    * `getPayHeroStatus` reads the row WITHOUT decrypting, so merely opening the
//      admin screen never puts the credential in server memory.
//    * Authorization is checked server-side against the caller's own profile. The
//      route guard in the UI is a convenience, not the control.
//
//  Deploy:  supabase functions deploy payhero-admin
// =============================================================================

import { adminFromEnv } from '../_shared/hashback-credentials.ts'
import {
  getPayHeroStatus,
  storePayHeroCredentials,
  recordPayHeroVerification,
  clearPayHeroCredentials,
  resolvePayHeroCredentials,
  PayHeroCredentialError,
} from '../_shared/payhero-credentials.ts'
import { PayHeroClient } from '../_shared/payhero.ts'

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
    console.error('payhero-admin: SUPABASE_URL or service key missing')
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
  // credential or assigning another ISP's channel is not a tenant capability.
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
    action?:
      | 'status'
      | 'save'
      | 'verify'
      | 'refresh'
      | 'assign'
      | 'disconnect'
      | 'isps'
    apiToken?: string
    callbackUrl?: string | null
    ispId?: string
    channelId?: number
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Malformed request' }, 400)
  }

  const action = body.action ?? 'status'

  try {
    // Reads the row without decrypting: nothing secret is loaded.
    if (action === 'status') {
      return json({ ok: true, status: await getPayHeroStatus(admin) })
    }

    if (action === 'save') {
      // Blank means "leave unchanged", not "clear", so a form that submits one
      // empty write-only field cannot wipe a working configuration.
      const apiToken = typeof body.apiToken === 'string' ? body.apiToken.trim() : ''
      if (!apiToken && body.callbackUrl === undefined) {
        return json({ error: 'Enter the PayHero API token.' }, 400)
      }

      const status = await storePayHeroCredentials(admin, {
        apiToken,
        callbackUrl: body.callbackUrl,
      })

      await admin.from('audit_logs').insert({
        actor_id: userData.user.id,
        actor_role: 'super_admin',
        action: 'payment:payhero-credentials-updated',
        target_type: 'platform_payment_config',
        // Records THAT a change happened, never what was in it.
        metadata: { api_token_changed: apiToken !== '' },
      })

      // Returns booleans only. No ciphertext, no token.
      return json({ ok: true, status })
    }
    // ── verify / refresh ─────────────────────────────────────────────────────
    //
    // Both call the live API. `verify` also records the outcome; `refresh` is the
    // same call without changing the recorded verdict, so an operator can pull
    // fresh channels without disturbing a 'verified' state.
    if (action === 'verify' || action === 'refresh') {
      let creds
      try {
        creds = await resolvePayHeroCredentials(admin)
      } catch (err) {
        if (err instanceof PayHeroCredentialError) {
          return json({ error: err.message, status: await getPayHeroStatus(admin) }, 400)
        }
        throw err
      }

      const client = new PayHeroClient({ apiToken: creds.apiToken })

      // One inspect() covers account, balance, currency and channels together, so
      // the admin screen never shows a half-discovered account.
      const connection = await client.inspect()

      const status =
        action === 'refresh'
          ? await getPayHeroStatus(admin)
          : await recordPayHeroVerification(admin, {
              connectionStatus: 'verified',
              lastError: null,
              accountId: connection.accountId,
              balance: connection.balance,
              currency: connection.currency,
              channels: connection.channels,
            })

      if (action === 'verify') {
        await admin.from('audit_logs').insert({
          actor_id: userData.user.id,
          actor_role: 'super_admin',
          action: 'payment:payhero-verified',
          target_type: 'platform_payment_config',
          metadata: {
            account_id: connection.accountId,
            balance: connection.balance,
            channels: connection.channels.length,
          },
        })
      }

      // The freshly discovered values are returned so the UI updates without a
      // second round trip. Contains no credential.
      return json({
        ok: true,
        apiAvailable: connection.apiReachable,
        accountId: connection.accountId,
        balance: connection.balance,
        currency: connection.currency,
        channels: connection.channels.map((c) => ({
          id: c.id,
          channelType: c.channel_type,
          shortCode: c.short_code,
          accountNumber: c.account_number,
          description: c.description,
          isActive: c.is_active,
        })),
        status,
      })
    }

    // ── assign ─────────────────────────────────────────────────────────────
    //
    // Binds one discovered PayHero channel to exactly one ISP. The uniqueness
    // rule is enforced in the database function, not here, so a crafted request
    // cannot give two tenants the same Till.
    if (action === 'assign') {
      const ispId = typeof body.ispId === 'string' ? body.ispId : ''
      const channelId = Number(body.channelId)
      if (!ispId || !Number.isInteger(channelId) || channelId <= 0) {
        return json({ error: 'Choose an ISP and a PayHero channel.' }, 400)
      }

      const { data, error } = await admin.rpc('assign_payhero_channel', {
        p_isp_id: ispId,
        p_channel_id: channelId,
      })
      if (error) return json({ error: error.message }, 400)

      const result = data as { ok?: boolean; reason?: string; message?: string } | null
      if (!result?.ok) {
        return json({ error: result?.message ?? 'That channel could not be assigned.' }, 409)
      }

      await admin.from('audit_logs').insert({
        actor_id: userData.user.id,
        actor_role: 'super_admin',
        isp_id: ispId,
        action: 'payment:payhero-channel-assigned',
        target_type: 'isp_payment_config',
        target_id: ispId,
        metadata: { payhero_channel_id: channelId, provider: 'payhero' },
      })

      return json({ ok: true, status: await getPayHeroStatus(admin) })
    }

    // ── isps ─────────────────────────────────────────────────────────────────
//
// Lists the tenants a channel may be assigned to, with whatever each one is
// already using. An operator picking a Till needs to see which ISP each row is
// and whether it is already taken, otherwise assigning the wrong one is easy and
// the mistake only surfaces when a customer pays the wrong merchant.
//
// The name and the currently-assigned channel are not secrets; the credential
// never appears here.
if (action === 'isps') {
      const { data } = await admin
        .from('isp_payment_configs')
        .select('isp_id, payment_provider, payhero_channel_id, connection_status')

      const configs = new Map(
        ((data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.isp_id), r]),
      )

      const { data: isps } = await admin.from('isps').select('id, name').order('name')
      const rows = ((isps ?? []) as Array<{ id: string; name: string }>).map((isp) => {
        const cfg = configs.get(isp.id) ?? {}
        return {
          id: isp.id,
          name: isp.name,
          // Surfaced as text, not a selector value, so the operator can see that
          // a tenant is already collecting elsewhere before reassigning it.
          currentProvider: (cfg.payment_provider as string) ?? null,
          currentChannelId: (cfg.payhero_channel_id as number | null) ?? null,
          connectionStatus: (cfg.connection_status as string) ?? 'not_configured',
        }
      })

      return json({ ok: true, isps: rows })
    }

    if (action === 'disconnect') {
      const status = await clearPayHeroCredentials(admin)
      await admin.from('audit_logs').insert({
        actor_id: userData.user.id,
        actor_role: 'super_admin',
        action: 'payment:payhero-disconnected',
        target_type: 'platform_payment_config',
        metadata: { provider: 'payhero' },
      })
      return json({ ok: true, status })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (err) {
    // Never echo an internal message that might quote a secret. The audit trail
    // and the status endpoint carry the diagnosis.
    if (err instanceof PayHeroCredentialError) {
      return json({ error: err.message }, 400)
    }
    console.error('payhero-admin: request failed')
    return json({ error: 'The request could not be completed.' }, 500)
  }
})