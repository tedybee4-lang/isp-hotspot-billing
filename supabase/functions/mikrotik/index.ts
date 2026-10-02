// =============================================================================
//  MikroTik management - Supabase Edge Function (Deno)
//
//  Actions (POST):
//    test        { host, port, username, password }   -> reachability check
//    save        { nodeId, username, password }      -> store encrypted creds
//    poll        { nodeId }                          -> one-off telemetry read
//    list-users  { nodeId }                          -> HotSpot active users
//    disconnect  { sessionId }                       -> end a live session
//    raw         { nodeId, command }                 -> debug escape hatch
//
//  The tenant always comes from the caller's own profile. A body `ispId` is
//  honoured only for a super admin, so tenant staff cannot drive another ISP's
//  routers - the same rule the stk-push function follows.
//
//  Deploy:
//    supabase secrets set ROUTER_CREDENTIALS_KEY=<random 48 chars>
//    supabase functions deploy mikrotik --no-verify-jwt
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  RouterError, listHotspotUsers, readTelemetry, removeHotspotUser, ros,
} from '../_shared/mikrotik.ts'
import { decryptSecret, encryptSecret } from '../_shared/secrets.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

type Admin = ReturnType<typeof createClient>

interface Actor { id: string; role: string; ispId: string | null }

/** Loads and decrypts the credentials for a node, or throws a clear error. */
async function loadCreds(admin: Admin, nodeId: string) {
  const { data: node, error } = await admin
    .from('nodes')
    .select('id, isp_id, name, host, api_port')
    .eq('id', nodeId)
    .single()
  if (error || !node) throw new RouterError('Router not found.')
  if (!node.host) throw new RouterError('This router has no host address set.')

  const { data: stored } = await admin
    .from('router_credentials')
    .select('username_ciphertext, password_ciphertext')
    .eq('node_id', nodeId)
    .maybeSingle()

  if (!stored) throw new RouterError('No credentials saved for this router yet.')

  return {
    node,
    creds: {
      host: node.host,
      port: Number(node.api_port ?? 8728),
      username: await decryptSecret(stored.username_ciphertext),
      password: await decryptSecret(stored.password_ciphertext),
    },
  }
}

/** Resolves the tenant the caller may act on. */
function assertTenant(actor: Actor, requested?: string): string {
  if (actor.role === 'super_admin') {
    const id = requested ?? actor.ispId
    if (!id) throw new RouterError('No ISP in scope.')
    return id
  }
  if (!actor.ispId) throw new RouterError('You are not attached to an ISP.')
  if (requested && requested !== actor.ispId) {
    throw new RouterError('You cannot manage another ISP')
  }
  return actor.ispId
}

/** Rejects a row that belongs to a different tenant. */
function assertSameTenant(actor: Actor, tenantId: string, rowIspId: string) {
  if (actor.role !== 'super_admin' && rowIspId !== tenantId) {
    throw new RouterError('That record belongs to another ISP')
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    })

    // â”€â”€ 1. Authenticate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Missing bearer token' }, 401)

    const { data: userData, error: userErr } = await admin.auth.getUser(token)
    if (userErr || !userData.user) return json({ error: 'Invalid or expired session' }, 401)

    const { data: profile } = await admin
      .from('profiles').select('role, isp_id').eq('id', userData.user.id).single()

    if (!profile || !['super_admin', 'isp_owner', 'isp_admin'].includes(profile.role)) {
      return json({ error: 'Only ISP owners or admins can manage routers' }, 403)
    }
    const actor: Actor = { id: userData.user.id, role: profile.role, ispId: profile.isp_id }

    const body = await req.json().catch(() => ({}))
    const action = String(body.action ?? '')

    // â”€â”€ 2. test â€” needs no stored credentials â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'test') {
      const host = String(body.host ?? '').trim()
      if (!host) return json({ error: 'host is required' }, 400)
      const creds = {
        host,
        port: Number(body.port ?? 8728),
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
      }
      try {
        const started = Date.now()
        const telemetry = await readTelemetry(creds, 8000)
        return json({
          ok: true,
          latencyMs: Date.now() - started,
          identity: telemetry.identity,
          model: telemetry.model,
          version: telemetry.version,
          activeUsers: telemetry.activeUsers,
        })
      } catch (err) {
        return json(
          { ok: false, error: err instanceof RouterError ? err.message : String(err) },
          200,
        )
      }
    }

    // â”€â”€ 3. save â€” encrypt and store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'save') {
      const nodeId = String(body.nodeId ?? '')
      if (!nodeId) return json({ error: 'nodeId is required' }, 400)
      const { data: node } = await admin
        .from('nodes').select('id, isp_id, host').eq('id', nodeId).single()
      if (!node) return json({ error: 'Router not found' }, 404)

      try {
        const scoped = assertTenant(actor, String(body.ispId ?? '') || undefined)
        assertSameTenant(actor, scoped, node.isp_id)
      } catch (err) {
        return json({ error: (err as Error).message }, 403)
      }

      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')
      if (!username || !password) {
        return json({ error: 'username and password are required' }, 400)
      }

      const { error } = await admin.from('router_credentials').upsert({
        node_id: nodeId,
        isp_id: node.isp_id,
        username_ciphertext: await encryptSecret(username),
        password_ciphertext: await encryptSecret(password),
        algorithm: 'aes-256-gcm',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'node_id' })
      if (error) return json({ error: error.message }, 500)

      await admin.from('nodes').update({ last_error: null }).eq('id', nodeId)
      return json({ ok: true })
    }

    const nodeId = String(body.nodeId ?? '')
    if (!nodeId) return json({ error: 'nodeId is required' }, 400)

    let tenantId: string
    try {
      tenantId = assertTenant(actor, String(body.ispId ?? '') || undefined)
    } catch (err) {
      return json({ error: (err as Error).message }, 403)
    }

    // â”€â”€ 4. list-users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'list-users') {
      const { node, creds } = await loadCreds(admin, nodeId)
      try {
        assertSameTenant(actor, tenantId, node.isp_id)
      } catch (err) {
        return json({ error: (err as Error).message }, 403)
      }
      return json({ ok: true, users: await listHotspotUsers(creds) })
    }

    // â”€â”€ 5. disconnect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'disconnect') {
      const sessionId = String(body.sessionId ?? '')
      if (!sessionId) return json({ error: 'sessionId is required' }, 400)

      const { data: session } = await admin
        .from('sessions')
        .select('id, isp_id, node_id, mac_address, ended_at')
        .eq('id', sessionId).single()
      if (!session) return json({ error: 'Session not found' }, 404)

      try {
        assertSameTenant(actor, tenantId, session.isp_id)
      } catch (err) {
        return json({ error: (err as Error).message }, 403)
      }
      if (session.ended_at) return json({ ok: true, alreadyEnded: true })
      if (!session.node_id) {
        return json({ error: 'This session is not attached to a router' }, 400)
      }

      const { node, creds } = await loadCreds(admin, session.node_id)

      // Prefer the MAC address, which survives a reconnect.
      let removed = false
      if (session.mac_address) {
        const users = await listHotspotUsers(creds)
        const match = users.find((u) => u.macAddress === session.mac_address)
        if (match?.id) {
          await removeHotspotUser(creds, match.id)
          removed = true
        }
      }

      await admin.from('sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', sessionId)

      return json({ ok: true, removedOnRouter: removed, node: node.name })
    }

    // â”€â”€ 6. poll â€” a single on-demand read â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'poll') {
      const { node, creds } = await loadCreds(admin, nodeId)
      try {
        assertSameTenant(actor, tenantId, node.isp_id)
      } catch (err) {
        return json({ error: (err as Error).message }, 403)
      }
      const started = Date.now()
      const t = await readTelemetry(creds)
      const latency = Date.now() - started
      const now = new Date().toISOString()

      await admin.from('nodes').update({
        status: 'online',
        last_seen: now,
        last_poll_at: now,
        last_error: null,
        last_latency_ms: latency,
        active_users: t.activeUsers,
        cpu_load: t.cpuLoadPercent,
        ram_used_mb: t.ramUsedMb,
        ram_total_mb: t.ramTotalMb,
        uptime_seconds: t.uptimeSeconds,
        model: t.model ?? null,
        os_version: t.version ?? null,
        serial_number: t.serial ?? null,
      }).eq('id', nodeId)

      return json({ ok: true, latencyMs: latency, telemetry: t })
    }

    // â”€â”€ 7. raw â€” escape hatch for debugging a router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (action === 'raw') {
      const { creds } = await loadCreds(admin, nodeId)
      return json({
        ok: true,
        rows: await ros(creds, String(body.command ?? ''), body.params ?? {}),
      })
    }

    return json({ error: `Unknown action: ${action || '(none)'}` }, 400)
  } catch (err) {
    return json({ error: err instanceof RouterError ? err.message : String(err) }, 500)
  }
})