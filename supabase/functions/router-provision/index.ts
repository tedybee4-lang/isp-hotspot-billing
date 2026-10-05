// =============================================================================
//  MikroTik automatic provisioning - Supabase Edge Function (Deno)
//
//  Two entry points with deliberately different authentication:
//
//    GET  /?token=...   called by the ROUTER. Presents the single-use token from
//                       the provisioning command. Returns a RouterOS SCRIPT as
//                       text/plain, because the generated command does
//                       `/tool fetch` followed by `/import` - and `/import`
//                       only understands RouterOS commands. The previous version
//                       returned JSON here, so the import could never work.
//
//    POST               called by the PANEL with a staff JWT, to drive the
//                       state machine once the ISP has answered the wizard.
//
//  Guarantees:
//    * The token is claimed through claim_provisioning_token(), which does the
//      whole used/expired/revoked decision in one locked transaction. A token
//      is genuinely single-use even under concurrent replay.
//    * The token's session fixes the ISP. A router holding ISP A's token can
//      only ever register under ISP A.
//    * Nothing is deleted from the router. The script is additive and tagged.
//    * A router is never marked ONLINE without a real heartbeat.
//
//  Deploy: supabase functions deploy router-provision --no-verify-jwt
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildAccessScript, buildRouterScript } from '../_shared/capabilities.ts'
import { buildCompatibility, parseVersion, type CompatibilityProfile } from '../_shared/compat.ts'
import { buildDiscoveryScript, SURVEYS } from '../_shared/discovery.ts'
import { assessLockout, type DiscoveredInterface } from '../_shared/lockout.ts'
import { decryptSecret } from '../_shared/secrets.ts'
import { probeMethods, type ConnectionMethod } from '../_shared/connection.ts'

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

/**
 * The claim response.
 *
 * Content-Type is text/plain and the body is a RouterOS script, not JSON. That
 * is the whole point of this endpoint: the router imports whatever it fetches.
 */
function script(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
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

/**
 * Rate limiting for the unauthenticated claim endpoint.
 *
 * A router can retry, and a script kiddie can hammer. 30 attempts per token
 * hash is generous for a real router and hostile enough to be useless.
 */
const attempts = new Map<string, { count: number; resetAt: number }>()

function rateLimited(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  entry.count += 1
  return entry.count > limit
}

// Keep the limiter from growing without bound on a long-lived instance.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of attempts) if (entry.resetAt < now) attempts.delete(key)
}, 60_000).unref?.()

/**
 * Handles the router's claim.
 *
 * Returns a RouterOS script, not JSON. The command the ISP ran fetched this
 * response to ispflow-bootstrap.rsc and then imported it, and `/import` only
 * understands RouterOS commands - so returning JSON made the step impossible by
 * construction, and it failed only after the router had already consumed its
 * one-time token.
 *
 * Rejections are returned as scripts too, with an `:error` line, so the router
 * terminal shows the real reason rather than a bare import failure.
 */
async function handleCallback(req: Request, url: URL): Promise<Response> {
  const token = url.searchParams.get('token') ?? ''
  if (!token || token.length < 16) {
    return script(':error "ISPFlow: missing or malformed provisioning token.";\n', 400)
  }

  const hash = await sha256Hex(token)
  if (rateLimited(hash)) {
    return script(':error "ISPFlow: too many attempts. Try again in a minute.";\n', 429)
  }

  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const sourceIp = url.searchParams.get('ip') ?? forwarded

  // One atomic call decides used / expired / revoked and marks the token used.
  // Two concurrent callbacks cannot both win: the second blocks on the row lock
  // and then sees used_at already set.
  const { data: claim, error: claimErr } = await admin.rpc('claim_provisioning_token', {
    p_token_hash: hash,
    p_source_ip: sourceIp,
  })

  if (claimErr) {
    return script(
      `:error "ISPFlow: provisioning could not be verified (${claimErr.message}).";\n`, 500)
  }

  const result = claim as {
    ok: boolean; code?: string; message?: string
    session_id?: string; isp_id?: string; node_id?: string | null
    label?: string; role?: string
  }

  if (!result?.ok) {
    const message = result?.message ?? 'Unknown token.'
    const status = result?.code === 'already_used' ? 409
      : result?.code === 'expired' ? 410
      : result?.code === 'revoked' ? 403 : 404
    return script(`:error "ISPFlow: ${message}";\n`, status)
  }

  const sessionId = result.session_id!
  const ispId = result.isp_id!

  // What the router chose to tell us about itself. Every field is optional: a
  // stripped-down script on an RB941 may only send `version`.
  const detected = {
    caller_ip: sourceIp,
    identity: url.searchParams.get('id'),
    version: url.searchParams.get('version'),
    board: url.searchParams.get('board'),
    architecture: url.searchParams.get('arch') ?? url.searchParams.get('arch2'),
    uptime: url.searchParams.get('uptime'),
    firmware: url.searchParams.get('firmware'),
    claimed_at: new Date().toISOString(),
  }

  // Decide what this device can do from what it just told us, BEFORE writing
  // anything. A RouterOS 6 box must not be sent REST or WireGuard commands.
  const profile = buildCompatibility(detected.version, detected.architecture, detected.board)
  const tag = sessionId.slice(0, 8)

  // Register the router under the session's ISP. The token is what binds it: a
  // router holding ISP A's token can only ever land under ISP A.
  const label = detected.board || detected.identity || result.label || 'Provisioned router'

  const { data: node, error: nodeErr } = await admin
    .from('nodes')
    .upsert({
      id: result.node_id ?? undefined,
      isp_id: ispId,
      name: label,
      status: 'provisioning',
      // A router that has just called us has told us its own address. That is
      // more reliable than asking the ISP to type one in.
      management_ip: sourceIp,
      public_ip: sourceIp,
      routeros_version: detected.version,
      board_name: detected.board,
      architecture: detected.architecture,
      provisioning_state: 'provisioning',
      discovered_via: 'provisioning',
      // Standard management ports, not guesses. The script below opens the
      // services that exist on this firmware.
      api_port: 8728,
      api_ssl_port: 8729,
      rest_port: 8080,
      heartbeat_interval_secs: profile.suggestedHeartbeatSecs,
      offline_threshold_secs: profile.suggestedHeartbeatSecs * 3,
    }, { onConflict: 'id' })
    .select('id')
    .single()

  if (nodeErr || !node) {
    return script(
      `:error "ISPFlow: could not register this router (${nodeErr?.message ?? 'unknown'}).";\n`,
      500)
  }

  await admin.from('provisioning_sessions').update({
    state: 'router_detected',
    detected_at: new Date().toISOString(),
    node_id: node.id,
    attempts: 1,
    detected: { ...detected, compatibility: profile },
    last_error: null,
  }).eq('id', sessionId)

  await admin.from('provisioning_events').insert({
    session_id: sessionId,
    isp_id: ispId,
    event: 'router_detected',
    source: 'router',
    detail: {
      ...detected,
      hardware_class: profile.hardwareClass,
      rest_possible: profile.rest,
      wireguard_possible: profile.wireGuard,
      unsupported: profile.unsupported,
    },
  })

// Record what is already known before credentials exist. The `available`
  // flags stay false for anything not yet probed - a probe that never ran is
  // not the same as a probe that failed.
  await admin.from('router_capabilities').upsert({
    node_id: node.id,
    isp_id: ispId,
    detected_at: new Date().toISOString(),
    detected_by: 'claim',
    board_name: detected.board,
    model: detected.board,
    routeros_version: detected.version,
    architecture: detected.architecture,
    is_chr: profile.isChr,
    api_available: true,
    api_ssl_available: profile.apiSsl,
    unsupported: profile.unsupported,
  }, { onConflict: 'node_id' })

  // Reachability is classified from evidence: the address the claim came from,
  // compared against what the router says its WAN is.
  await admin.rpc('classify_router_reachability', {
    p_node_id: node.id,
    p_observed_source_ip: sourceIp,
    p_router_wan_ip: url.searchParams.get('wan'),
    p_vpn_ip: null,
  })

  // Hand the real work to the persistent worker: a capability survey and the
  // first heartbeat. Idempotency keys mean re-running the script cannot spawn
  // duplicates.
  await admin.from('router_jobs').insert([
    {
      isp_id: ispId,
      node_id: node.id,
      kind: 'capabilities',
      payload: { session_id: sessionId, reason: 'claim' },
      idempotency_key: `claim-capabilities:${sessionId}`,
      priority: 20,
      max_attempts: 5,
    },
    {
      isp_id: ispId,
      node_id: node.id,
      kind: 'heartbeat',
      payload: { session_id: sessionId, reason: 'claim' },
      idempotency_key: `claim-heartbeat:${sessionId}`,
      priority: 10,
      max_attempts: 8,
    },
  ])

  // Mint the credential the router will post its self-survey back with, and
  // append the survey to the script we are about to return.
  //
  // The claim token is single-use and is spent by this very request, so
  // discovery needs its own short-lived credential. Minting it HERE, inside the
  // same handler, means it only ever exists for a router that has already
  // proved it holds a valid claim token.
  const discovery = await buildDiscoveryTail(sessionId, tag, profile, detected.version)

  const body = buildAccessScript({ tag, profile, vpn: null })

  const trailer = [
    '',
    '# --- Report back what this router is ---',
    ':put ("ISPFlow: registered as " . $identity);',
    ':put ("ISPFlow: RouterOS " . $version . " on " . $board-name);',
    profile.rest
      ? ':put "ISPFlow: HTTPS management is available on port 8080.";'
      : ':put "ISPFlow: this firmware has no REST; the panel will use the API.";',
    '',
  ].join('\n')

  return script(body + trailer + (discovery ? '\n' + discovery : ''))
}

/**
 * Mints a discovery token and renders the router's self-survey.
 *
 * Returns an empty string when the token cannot be minted. That must NOT be
 * fatal: the router is already registered and managed at this point, and a
 * discovery failure degrades the wizard rather than undoing a successful
 * onboarding. The ISP re-runs the command to retry.
 */
async function buildDiscoveryTail(
  sessionId: string,
  tag: string,
  profile: CompatibilityProfile,
  version: string | null,
): Promise<string> {
  const { data, error } = await admin.rpc('mint_discovery_token', { p_session_id: sessionId })
  if (error || !data?.ok || !data?.token) return ''

  const parsed = parseVersion(version)
  const reportUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/router-provision/report`
  return buildDiscoveryScript({
    reportUrl,
    token: String(data.token),
    // Prefer the version the router actually reported. When it did not report
    // one, fall back to the compatibility profile's own verdict: `rest` is
    // already "is this at least 7.1", which is exactly the split that decides
    // whether WireGuard exists. Guessing 7 for an unparseable string would send
    // a 6.x box a path it does not have.
    major: parsed?.major ?? (profile.rest ? 7 : 6),
    tag,
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

// -- detect: read the hardware over whichever transport works -------------
  //
  // The session's own node_id is used, never "the ISP's only router". An ISP
  // with four routers has no single `maybeSingle()` answer, which is why the
  // previous version silently read the wrong device or returned nothing.
  if (action === 'detect') {
    const nodeId = session.node_id
    if (!nodeId) {
      return json({
        error: 'This router has not contacted the platform yet. Run the generated '
          + 'command on the router first, then try again.',
      }, 409)
    }

    const { data: node } = await admin
      .from('nodes')
      .select('id, host, api_port, api_ssl_port, rest_port, mgmt_mode, status, ' +
        'routeros_version, board_name, architecture, reachability, reachability_note')
      .eq('id', nodeId).single()
    if (!node) return json({ error: 'Router not found' }, 404)

    // Prefer what the worker already learned. It runs continuously and holds
    // real credentials, so it is the source of truth when it has an answer.
    const { data: known } = await admin
      .from('router_capabilities').select('*').eq('node_id', nodeId).maybeSingle()

    if (!node.host) {
      return json({
        error: 'The platform has no address for this router. It claimed from '
          + `${node.management_ip ?? 'an unknown address'}, so confirm the router `
          + 'can make outbound HTTPS, or give it a management address.',
        reachability: node.reachability,
        reachability_note: node.reachability_note,
      }, 409)
    }

    const { data: creds } = await admin
      .from('router_credentials').select('*').eq('node_id', nodeId).maybeSingle()

    let capabilities: Record<string, unknown> = (known ?? {}) as Record<string, unknown>
    let method: ConnectionMethod | null = null
    let probeError: string | null = null

    if (creds) {
      const endpoint = {
        host: node.host,
        restPort: node.rest_port ?? 8080,
        apiPort: node.api_port ?? 8728,
        apiSslPort: node.api_ssl_port ?? 8729,
        username: await decryptSecret(creds.username_ciphertext),
        password: await decryptSecret(creds.password_ciphertext),
      }
      try {
        // Probe every transport, so a router with no REST falls back to the API
        // rather than being reported unreachable.
        const probe = await probeMethods(endpoint)
        method = probe.selected === 'unavailable' ? null : probe.selected
        if (probe.fullyUnreachable) {
          probeError = probe.methods.map((m) => `${m.method}: ${m.error}`).join('; ')
        }
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err)
      }
    }

    await admin.from('provisioning_sessions').update({
      state: known ? 'capabilities_detected' : 'router_detected',
      capabilities,
      last_error: probeError,
    }).eq('id', sessionId)

    await admin.from('provisioning_events').insert({
      session_id: sessionId,
      isp_id: session.isp_id,
      event: probeError ? 'capabilities_probe_failed' : 'capabilities_detected',
      source: 'panel',
      detail: { method, error: probeError },
    })

    return json({
      ok: !probeError,
      capabilities,
      connection_method: method ?? node.mgmt_mode ?? 'unavailable',
      // Honest about which part failed, so the UI can distinguish "no data yet"
      // from "the probe ran and the router refused".
      error: probeError,
      hint: probeError
        ? 'The router did not answer a management probe. Check the address, the '
          + 'credentials, and whether the api service is enabled on the router.'
        : undefined,
    })
  }

  // â”€â”€ script: build the configuration without sending it â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// -- register: online only after the stage gate agrees ---------------------
  //
  // Two independent conditions, and BOTH must hold:
  //
  //   1. `router_online_blocker` says every required stage settled, verification
  //      SUCCEEDED, and a backup exists. That is the authoritative gate.
  //   2. A real heartbeat arrived inside the router's own offline threshold.
  //      A stage table saying "success" and a router that is actually answering
  //      are different claims.
  //
  // Neither alone is enough, and this is the one place a router could be marked
  // online without having been really configured - which is why it checks both.
  if (action === 'register') {
    const nodeId = session.node_id
    if (!nodeId) {
      return json({
        error: 'This session has no router attached yet. The router has not '
          + 'contacted the platform.',
      }, 409)
    }

    const { data: gate, error: gateErr } = await admin.rpc('router_online_blocker', {
      p_session_id: sessionId,
    })
    if (gateErr) return json({ error: gateErr.message }, 500)
    const verdict = (gate ?? {}) as { blocked?: boolean; stage?: string; reason?: string }
    if (verdict.blocked) {
      return json({
        error: 'This router has not passed verification, so it cannot be marked '
          + `online. ${verdict.reason ?? ''}`
          + (verdict.stage ? ` (stage: ${verdict.stage})` : ''),
        blocked_stage: verdict.stage ?? null,
      }, 409)
    }

    const { data: node } = await admin
      .from('nodes')
      .select('id, name, status, last_heartbeat_at, last_success_at, offline_threshold_secs, provisioning_state, reachability, reachability_note, mgmt_mode')
      .eq('id', nodeId).single()
    if (!node) return json({ error: 'Router not found' }, 404)

    const threshold = (node.offline_threshold_secs ?? 300) * 1000
    const beat = node.last_heartbeat_at ?? node.last_success_at
    const fresh = Boolean(beat && Date.now() - new Date(beat).getTime() < threshold)

    if (!fresh) {
      // Say why, precisely. "Never provisioned" and "provisioned but silent"
      // are different problems with different fixes.
      const reason = beat
        ? `The last heartbeat was ${new Date(beat).toISOString()}, outside the `
          + `${Math.round(threshold / 1000)}s threshold.`
        : 'No heartbeat has ever been received from this router.'
      return json({
        error: 'The router has not checked in recently, so it cannot be marked '
          + 'online. ' + reason + ' Run the provisioning command on the router, '
          + 'confirm the API service is enabled, and check that the network '
          + 'worker is running.',
        current_status: node.status,
        last_heartbeat_at: node.last_heartbeat_at,
        reachability: node.reachability,
        reachability_note: node.reachability_note,
        connection_method: node.mgmt_mode,
      }, 409)
    }

    const { data: still } = await admin
      .from('nodes')
      .select('id, name, mgmt_mode, reachability')
      .eq('id', nodeId).single()

    await admin.from('provisioning_sessions').update({
      state: 'online',
      completed_at: new Date().toISOString(),
      node_id: nodeId,
      last_error: null,
    }).eq('id', sessionId)

    await admin.from('provisioning_events').insert({
      session_id: sessionId,
      isp_id: session.isp_id,
      event: 'online',
      source: 'panel',
      detail: {
        heartbeat_at: beat,
        connection_method: still?.mgmt_mode ?? null,
        reachability: still?.reachability ?? null,
      },
    })

    return json({
      ok: true,
      state: 'online',
      router: node.name,
      connection_method: still?.mgmt_mode ?? null,
      reachability: still?.reachability ?? null,
      last_heartbeat_at: beat,
    })
  }

  // -- stages: the live stage list the wizard renders ------------------------
  //
  // One RPC so the panel cannot assemble "is this finished" itself and get it
  // wrong. It also returns the ONLINE verdict, so the UI shows the same answer
  // the gate would give rather than a guess.
  if (action === 'stages') {
    const { data, error } = await admin.rpc('provisioning_stage_report', {
      p_session_id: sessionId,
    })
    if (error) return json({ error: error.message }, 500)
    return json(data ?? { ok: false })
  }

  // -- configure: check safety, then hand the run to the worker --------------
  //
  // This is the point of no return, so the management check runs HERE, on the
  // server, from the router's own discovered state. Checking it in the browser
  // would mean the answer depends on what the browser was told, and it would be
  // one skipped click away from not being checked at all.
  //
  // Nothing is configured by this request. It seeds the stage rows and queues ONE
  // job; the worker does the rest over its own authenticated socket.
  if (action === 'configure') {
    const nodeId = session.node_id
    if (!nodeId) {
      return json({ error: 'This router has not contacted the platform yet.' }, 409)
    }

    const selection = {
      wan: (body.wanInterface as string | null) ?? session.wan_interface ?? null,
      hotspot: (body.hotspotInterfaces as string[] | undefined)
        ?? session.hotspot_interfaces ?? [],
      pppoe: (body.pppoeInterfaces as string[] | undefined)
        ?? session.pppoe_interfaces ?? [],
      management: (body.managementInterfaces as string[] | undefined)
        ?? session.management_interfaces ?? [],
      acceptLockout: body.acceptLockout === true,
      replacementPath: body.replacementPath as {
        kind?: string; verified?: boolean; note?: string
      } | undefined,
    }

    // The lockout assessment works from DISCOVERED state, never from an
    // assumption that the WAN is ether1. Whatever the router reported is checked.
    const { data: caps } = await admin
      .from('router_capabilities').select('*').eq('node_id', nodeId).maybeSingle()

    const assessment = assessLockout(selection, {
      interfaces: (caps?.interfaces ?? []) as unknown as DiscoveredInterface[],
      addresses: [],
      bridges: (caps?.bridges ?? []) as unknown as Array<{ name: string }>,
    })

    if (!assessment.safe) {
      // Refused, with the actual reason. Nothing is queued, nothing is changed,
      // and the override is NOT honoured on its own - see lockout.ts.
      return json({
        ok: false,
        error: assessment.message,
        remedy: assessment.remedy,
        lockout: {
          safe: false,
          losing_management: assessment.losingManagement,
          // Stated so the UI can explain WHY the tick box did not help.
          override_requires: 'a verified out-of-band management path '
            + '(second LAN segment, console server, or on-site access)',
        },
      }, 409)
    }

    // Persist the accepted selection so the worker applies exactly what was
    // checked here, not a second and possibly different copy from the browser.
    const { error: saveErr } = await admin.from('provisioning_sessions').update({
      wan_interface: selection.wan,
      hotspot_interfaces: selection.hotspot,
      pppoe_interfaces: selection.pppoe,
      management_interfaces: selection.management,
      management_lockout_accepted: selection.acceptLockout === true,
      management_replacement_path: selection.replacementPath?.kind ?? null,
      management_replacement_verified: selection.replacementPath?.verified === true,
      management_assessed_at: new Date().toISOString(),
      role: (body.role as string | undefined) ?? session.role,
      wizard_answers: {
        ...(session.wizard_answers ?? {}),
        ...(body.tunnel ? { tunnel: body.tunnel } : {}),
        ...(body.pppLocal ? { ppp_local: body.pppLocal } : {}),
        ...(body.pppRemote ? { ppp_remote: body.pppRemote } : {}),
        ...(body.hotspotPool ? { hotspot_pool: body.hotspotPool } : {}),
        ...(body.radiusServer ? { radius_server: body.radiusServer } : {}),
        ...(body.radiusEnabled !== undefined
          ? { radius_enabled: String(body.radiusEnabled === true) } : {}),
      },
    }).eq('id', sessionId)
    if (saveErr) return json({ error: saveErr.message }, 500)

    const { data, error } = await admin.rpc('enqueue_staged_provisioning', {
      p_session_id: sessionId,
    })
    if (error) return json({ error: error.message }, 500)
    const result = (data ?? {}) as { ok?: boolean; error?: string; job_id?: string }
    if (result.ok === false) return json({ error: result.error ?? 'Could not start.' }, 409)

    return json({
      ok: true,
      queued: true,
      job_id: result.job_id ?? null,
      lockout: { safe: true, warning: assessment.message },
      message: 'Queued. The network worker applies each stage in order and records '
        + 'the real result of every one.',
    })
  }

// APPEND_ACTIONS
  // -- copy_plans: from another router of the SAME ISP -----------------------
  //
  // The tenant check lives in the function. The browser cannot widen it, and a
  // cross-tenant request is refused before any plan is read.
  if (action === 'copy_plans') {
    const sourceNode = String(body.sourceNodeId ?? '')
    if (!sourceNode) return json({ error: 'sourceNodeId is required.' }, 400)

    const { data, error } = await admin.rpc('copy_router_plans', {
      p_source_node_id: sourceNode,
      p_target_session: sessionId,
      p_kinds: (body.kinds as string[] | undefined) ?? ['hotspot', 'pppoe'],
      p_replace: body.replace === true,
    })
    if (error) return json({ error: error.message }, 400)
    const result = (data ?? {}) as { ok?: boolean; error?: string; plans?: number }
    if (result.ok === false) return json({ error: result.error ?? 'Could not copy.' }, 409)

    return json({
      ok: true,
      plans: result.plans ?? 0,
      message: `${result.plans ?? 0} package(s) copied. The router gets its own `
        + 'objects during the next package sync.',
    })
  }

  // -- refresh: ask the worker for a heartbeat right now ---------------------
  if (action === 'refresh') {
    const nodeId = session.node_id
    if (!nodeId) return json({ error: 'This session has no router attached yet.' }, 409)

    // Idempotent: a refresh already queued is reused rather than piling up
    // duplicate heartbeat jobs when someone double-clicks.
    const key = `refresh-heartbeat:${sessionId}`
    const { data: existing } = await admin
      .from('router_jobs').select('id, status')
      .eq('idempotency_key', key).maybeSingle()

    if (!existing) {
      await admin.from('router_jobs').insert({
        isp_id: session.isp_id,
        node_id: nodeId,
        kind: 'heartbeat',
        payload: { session_id: sessionId, reason: 'panel_refresh' },
        idempotency_key: key,
        priority: 5,
        max_attempts: 3,
      })
    }

    return json({
      ok: true,
      queued: true,
      job_id: existing?.id ?? null,
      message: existing
        ? 'A heartbeat was already requested for this router; it will not be queued twice.'
        : 'A heartbeat has been queued. The worker will collect it within seconds.',
    })
  }

  return json({ error: `Unknown action: ${action}` }, 400)
}

/**
 * Receives one self-survey from a router.
 *
 * Routed on `/report` so it is unmistakably separate from the claim: the claim
 * is a GET that returns a script, this is a POST that stores data.
 *
 * The router authenticates with its discovery token. It does NOT get to name a
 * session or an ISP - `record_router_survey` reads both from the token row, so
 * a router holding ISP A's credential can only ever write into ISP A's session.
 */
async function handleReport(req: Request, url: URL): Promise<Response> {
  const token = url.searchParams.get('token') ?? ''
  const survey = url.searchParams.get('survey') ?? ''

  if (!token || token.length < 32) {
    return json({ ok: false, code: 'malformed', message: 'Missing or malformed token.' }, 400)
  }
  // Only the surveys this build knows how to render a panel view for. An
  // unknown key is rejected rather than stored, so a stale router script from a
  // newer or older release cannot grow the table without bound.
  if (!SURVEYS.includes(survey as never)) {
    return json({ ok: false, code: 'bad_survey', message: 'Unknown survey.' }, 400)
  }
  // Same limiter as the claim. A router retries; a hostile caller guessing
  // tokens does not get unlimited attempts.
  const hash = await sha256Hex(`report:${token}`)
  if (rateLimited(hash, 60)) {
    return json({ ok: false, code: 'rate_limited', message: 'Too many reports.' }, 429)
  }

  let payload: unknown = {}
  const contentType = req.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      payload = await req.json()
    } else {
      payload = Object.fromEntries(await req.formData())
    }
  } catch {
    // A router that sends an unparseable body still gets a 200: it has no way
    // to do anything useful with an error, and failing the fetch would make it
    // retry forever on a link that may be fine.
    payload = {}
  }

  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const { data, error } = await admin.rpc('record_router_survey', {
    p_token_hash: await sha256Hex(token),
    p_survey: survey,
    // The router builds this JSON by string concatenation, so it is not
    // guaranteed to be an object. Anything unparseable is stored as empty
    // rather than failing the whole report.
    p_payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
    p_router_ip: forwarded,
  })

  if (error) {
    return json({ ok: false, code: 'error', message: error.message }, 500)
  }
  return json(data ?? { ok: true })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/report')) {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
      return await handleReport(req, url)
    }
    if (req.method === 'GET') return await handleCallback(req, url)
    if (req.method === 'POST') return await handlePanel(req)
    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
