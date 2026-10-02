// =============================================================================
//  MikroTik automatic provisioning - Supabase Edge Function (Deno)
//
//  Two entry points with deliberately different authentication:
//
//    GET  /?token=...   called by the ROUTER. It presents the single-use token
//                       from the provisioning command; we hash it, look up the
//                       session, and report what we found. No JWT: a router is
//                       not a user.
//
//    POST               called by the PANEL with a staff JWT, to drive the
//                       state machine once the ISP has answered the wizard.
//
//  Nothing here deletes router configuration, and a router is never marked
//  ONLINE without a real, recent successful heartbeat.
//
//  Deploy: supabase functions deploy router-provision --no-verify-jwt
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildRouterScript, detectHardware } from '../_shared/capabilities.ts'
import { decryptSecret } from '../_shared/secrets.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

type Admin = ReturnType<typeof createClient>

const sha256Hex = async (text: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

/** Handles the router's callback. */
async function handleCallback(req: Request, url: URL): Promise<Response> {
  const token = url.searchParams.get('token') ?? ''
  if (!token || token.length < 16) return json({ error: 'Missing or malformed token.' }, 400)

  // Expire anything already lapsed before looking this one up.
  await admin.rpc('expire_provisioning_tokens')

  const hash = await sha256Hex(token)
  const { data: row } = await admin
    .from('provisioning_tokens')
    .select('id, session_id, isp_id, expires_at, revoked_at, used_at')
    .eq('token_hash', hash)
    .maybeSingle()

  if (!row) return json({ error: 'Unknown token.' }, 404)
  if (row.revoked_at) return json({ error: 'This provisioning link was revoked.' }, 403)
  if (new Date(row.expires_at) < new Date()) {
    return json({ error: 'This provisioning link has expired. Generate a new command.' }, 410)
  }

  const { data: session } = await admin
    .from('provisioning_sessions').select('*').eq('id', row.session_id).single()
  if (!session) return json({ error: 'Provisioning session missing.' }, 404)

  // What the router chose to tell us about itself.
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const detected = {
    caller_ip: url.searchParams.get('ip') ?? forwarded,
    firmware: url.searchParams.get('firmware'),
    board: url.searchParams.get('board'),
    version: url.searchParams.get('version'),
    architecture: url.searchParams.get('architecture'),
  }

  if (session.state === 'created' || session.state === 'command_generated') {
    await admin.from('provisioning_sessions').update({
      state: 'router_detected',
      detected_at: new Date().toISOString(),
      attempts: (session.attempts ?? 0) + 1,
      detected,
    }).eq('id', session.id)
    await admin.from('provisioning_events').insert({
      session_id: session.id,
      isp_id: session.isp_id,
      event: 'router_detected',
      source: 'router',
      detail: detected,
    })
  }

  // Capability detection needs credentials, which do not exist on first
  // contact. Saying so is better than returning an empty interface list that
  // would look like a router with no ports.
  const { data: node } = await admin
    .from('nodes').select('id').eq('isp_id', session.isp_id).maybeSingle()
  const { data: creds } = node
    ? await admin.from('router_credentials')
      .select('node_id').eq('node_id', node.id).maybeSingle()
    : { data: null }

  return json({
    ok: true,
    session_id: session.id,
    state: session.state,
    detected,
    needs_selection: true,
    message: creds
      ? 'Detected. The ISP must confirm interfaces in the panel to continue.'
      : 'Detected. The ISP must save this router credentials in the panel to continue.',
  })
}

/** Handles a panel request (staff JWT required). */
async function handlePanel(req: Request): Promise<Response> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!token) return json({ error: 'Missing bearer token' }, 401)
  const { data: userData } = await admin.auth.getUser(token)
  if (!userData.user) return json({ error: 'Invalid session' }, 401)

  const { data: profile } = await admin
    .from('profiles').select('role, isp_id').eq('id', userData.user.id).single()
  if (!profile || !['super_admin', 'isp_owner', 'isp_admin'].includes(profile.role)) {
    return json({ error: 'Only ISP owners or admins can provision routers' }, 403)
  }

  const body = await req.json().catch(() => ({}))
  const sessionId = String(body.sessionId ?? '')
  const action = String(body.action ?? '')
  if (!sessionId) return json({ error: 'sessionId is required' }, 400)

  const { data: session } = await admin
    .from('provisioning_sessions').select('*').eq('id', sessionId).single()
  if (!session) return json({ error: 'Provisioning session not found' }, 404)
  if (profile.role !== 'super_admin' && session.isp_id !== profile.isp_id) {
    return json({ error: 'That session belongs to another ISP' }, 403)
  }

  const t = session.id.slice(0, 8)

  // ── detect: read the hardware over the RouterOS API ──────────────────────
  if (action === 'detect') {
    const { data: node } = await admin
      .from('nodes').select('id, host, api_port').eq('isp_id', session.isp_id).maybeSingle()
    const { data: creds } = node
      ? await admin.from('router_credentials')
        .select('*').eq('node_id', node.id).maybeSingle()
      : { data: null }

    if (!node?.host || !creds) {
      return json({ error: 'Add this router and save its credentials first.' }, 400)
    }

    const capabilities = await detectHardware({
      host: node.host,
      port: Number(node.api_port ?? 8728),
      username: await decryptSecret(creds.username_ciphertext),
      password: await decryptSecret(creds.password_ciphertext),
    })

    await admin.from('provisioning_sessions')
      .update({ state: 'capabilities_detected', capabilities })
      .eq('id', sessionId)
    await admin.from('provisioning_events').insert({
      session_id: sessionId,
      isp_id: session.isp_id,
      event: 'capabilities_detected',
      source: 'panel',
      detail: capabilities,
    })

    return json({ ok: true, capabilities })
  }

  // ── script: build the configuration without sending it ───────────────────
  if (action === 'script') {
    const { data: net } = await admin
      .from('network_settings').select('*').eq('isp_id', session.isp_id).maybeSingle()

    const script = buildRouterScript({
      tag: t,
      role: (session.role as 'hotspot' | 'pppoe' | 'both') ?? 'hotspot',
      hotspotInterfaces: session.hotspot_interfaces ?? [],
      pppoeInterfaces: session.pppoe_interfaces ?? [],
      wanInterface: session.wan_interface ?? null,
      dns: [net?.primary_dns, net?.secondary_dns].filter(Boolean) as string[],
      sessionTimeoutMin: net?.session_timeout_min ?? 30,
      idleTimeoutMin: net?.idle_timeout_min ?? 5,
      radiusServer: net?.radius_server ?? null,
      radiusEnabled: Boolean(net?.radius_enabled),
    })

    await admin.from('provisioning_sessions')
      .update({ state: 'testing', config_script: script })
      .eq('id', sessionId)
    await admin.from('provisioning_events').insert({
      session_id: sessionId,
      isp_id: session.isp_id,
      event: 'script_generated',
      source: 'panel',
    })

    return json({ ok: true, script })
  }

  // ── register: online only after a real heartbeat ─────────────────────────
  if (action === 'register') {
    const { data: node } = await admin
      .from('nodes').select('id, name, status, last_seen')
      .eq('isp_id', session.isp_id).maybeSingle()
    if (!node) return json({ error: 'No router found for this ISP.' }, 400)

    // A click in the panel is not evidence that the router exists.
    const fresh = Boolean(
      node.last_seen && Date.now() - new Date(node.last_seen).getTime() < 5 * 60_000,
    )
    if (node.status !== 'online' || !fresh) {
      return json({
        error: 'The router has not checked in yet, so it cannot be marked online. ' +
          'Run the command on the router and wait for the first successful poll.',
        current_status: node.status,
      }, 409)
    }

    await admin.from('provisioning_sessions').update({
      state: 'online',
      completed_at: new Date().toISOString(),
      node_id: node.id,
    }).eq('id', sessionId)
    await admin.from('provisioning_events').insert({
      session_id: sessionId,
      isp_id: session.isp_id,
      event: 'online',
      source: 'panel',
    })

    return json({ ok: true, state: 'online', router: node.name })
  }

  return json({ error: `Unknown action: ${action}` }, 400)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (req.method === 'GET') return await handleCallback(req, new URL(req.url))
    if (req.method === 'POST') return await handlePanel(req)
    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})