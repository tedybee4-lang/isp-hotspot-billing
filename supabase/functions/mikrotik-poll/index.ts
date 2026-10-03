// =============================================================================
//  MikroTik telemetry poller - Supabase Edge Function (Deno)
//
//  Invoked on a schedule (see 20260101000700_router_management.sql) and walks
//  every enabled router, writing identity, resource and session readings back
//  into `nodes` and `sessions`.
//
//  This is what makes the Routers screen show real numbers instead of
//  "No data". A router that cannot be reached is marked offline with the
//  failure reason recorded - it is never silently left looking healthy.
//
//  Requires the service role. It is invoked by pg_cron, not from the browser,
//  and it authenticates the caller itself against the service-role key before
//  reading or writing anything - see isAuthorised() below for why.
//
//  Deploy:  supabase functions deploy mikrotik-poll --no-verify-jwt
//           (--no-verify-jwt is required for pg_cron, which has no user JWT;
//            the function then enforces the service-role bearer token itself)
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  listHotspotUsers, readTelemetry, RouterError, type RouterCredentials,
} from '../_shared/mikrotik.ts'
import { decryptSecret } from '../_shared/secrets.ts'
import { isAuthorised } from '../_shared/bearer-auth.ts'

/** One bad router must not abort the sweep. */
async function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p } catch { return fallback }
}

/**
 * The tokens this function will accept.
 *
 * Sources, in order:
 *   1. the service credentials Supabase injected into this function
 *   2. the token stored in public.poller_config, which is what the pg_cron
 *      job actually sends
 *
 * (2) matters because the injected key and the scheduled caller's key are not
 * guaranteed to be the same VALUE. Supabase exposes a legacy JWT on some
 * projects and an sb_secret_... on others, and poller_config holds whichever
 * one was stored when the schedule was set up. Comparing only against the
 * environment fails closed but invisibly: the poller returns 401 forever,
 * nobody notices, and every router slowly appears offline.
 *
 * poller_config has RLS enabled with no policies, so it is readable only by
 * the service role - which is this function.
 */
async function authorised(req: Request, admin: SupabaseClient): Promise<boolean> {
  const header = req.headers.get('authorization')
  if (isAuthorised(header, [
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    Deno.env.get('SUPABASE_SECRET_KEY'),
  ])) return true
  const { data } = await admin
    .from('poller_config').select('service_key').limit(1).maybeSingle()
  return isAuthorised(header, [data?.service_key])
}

Deno.serve(async (req) => {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )

  // Authenticate BEFORE reading or writing anything. This function is deployed
  // with --no-verify-jwt because pg_cron has no user session to present, so the
  // gateway check is unavailable and the caller is authenticated here instead.
  //
  // Without this an anonymous GET swept every router in the platform, decrypting
  // each stored router password, and wrote to nodes, sessions and
  // router_poll_runs. There is no legitimate unauthenticated caller.
  if (!(await authorised(req, admin))) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const summary: Array<{ node: string; ok: boolean; error?: string }> = []

  try {
    const { data: routers, error } = await admin
      .from('nodes')
      .select('id, isp_id, name, host, api_port')
      .eq('enabled', true)
      .not('host', 'is', null)
    if (error) throw new Error(error.message)

    for (const node of routers ?? []) {
      const startedAt = new Date().toISOString()
      let latency: number | null = null
      let usersSeen = 0
      let failure: string | null = null

      try {
        const { data: stored } = await admin
          .from('router_credentials')
          .select('username_ciphertext, password_ciphertext')
          .eq('node_id', node.id)
          .maybeSingle()

        if (!stored) {
          failure = 'No credentials saved for this router.'
        } else {
          const creds: RouterCredentials = {
            host: node.host as string,
            port: Number(node.api_port ?? 8728),
            username: await decryptSecret(stored.username_ciphertext),
            password: await decryptSecret(stored.password_ciphertext),
          }

          const begin = Date.now()
          const telemetry = await settle(readTelemetry(creds), null)
          if (!telemetry) {
            // readTelemetry swallows per-command errors, so an empty identity
            // AND zero users AND no cpu means the router refused us outright.
            throw new RouterError('Router did not answer any command.')
          }
          latency = Date.now() - begin

          await admin.from('nodes').update({
            status: 'online',
            last_seen: startedAt,
            last_poll_at: startedAt,
            last_error: null,
            last_latency_ms: latency,
            active_users: telemetry.activeUsers,
            cpu_load: telemetry.cpuLoadPercent,
            ram_used_mb: telemetry.ramUsedMb,
            ram_total_mb: telemetry.ramTotalMb,
            uptime_seconds: telemetry.uptimeSeconds,
            model: telemetry.model ?? null,
            os_version: telemetry.version ?? null,
            serial_number: telemetry.serial ?? null,
          }).eq('id', node.id)

          // Mirror live HotSpot sessions into the panel.
          const live = await settle(listHotspotUsers(creds), [])
          usersSeen = live.length
          await syncSessions(admin, node, live)
        }
      } catch (err) {
        failure = err instanceof RouterError ? err.message : String(err)
        await admin.from('nodes').update({
          status: 'offline',
          last_poll_at: startedAt,
          last_error: failure.slice(0, 500),
        }).eq('id', node.id)

        // Anything we previously believed was live is now unknown.
        await admin.from('sessions')
          .update({ ended_at: startedAt })
          .eq('node_id', node.id).is('ended_at', null)
      }

      await admin.from('router_poll_runs').insert({
        isp_id: node.isp_id,
        node_id: node.id,
        ok: failure === null,
        error: failure ? failure.slice(0, 500) : null,
        latency_ms: latency,
        users_seen: usersSeen,
        started_at: startedAt,
      })

      summary.push({ node: node.name, ok: failure === null, error: failure ?? undefined })
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err), summary }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const failed = summary.filter((s) => !s.ok).length
  return new Response(
    JSON.stringify({
      polled: summary.length,
      failed,
      summary,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})

/**
 * Replaces this router's session rows with what the router currently reports.
 *
 * Sessions are keyed on (node_id, mac_address): the same device reconnecting
 * keeps its identity, so a new row is only created for a MAC we have not seen
 * live before.
 */
async function syncSessions(
  admin: ReturnType<typeof createClient>,
  node: { id: string; isp_id: string },
  live: Awaited<ReturnType<typeof listHotspotUsers>>,
): Promise<void> {
  const now = new Date().toISOString()

  const { data: existing } = await admin
    .from('sessions')
    .select('id, mac_address')
    .eq('node_id', node.id)
    .is('ended_at', null)

  const liveMacs = new Set(live.map((u) => u.macAddress).filter(Boolean))
  const existingMacs = new Map(
    (existing ?? []).map((s) => [s.mac_address ?? '', s.id]),
  )

  // Close sessions the router no longer reports.
  const stale = (existing ?? [])
    .filter((s) => !liveMacs.has(s.mac_address ?? ''))
    .map((s) => s.id)
  if (stale.length) {
    await admin.from('sessions').update({ ended_at: now }).in('id', stale)
  }

  // Insert only genuinely new devices.
  const fresh = live
    .filter((u) => u.macAddress && !existingMacs.has(u.macAddress))
    .map((u) => ({
      isp_id: node.isp_id,
      node_id: node.id,
      mac_address: u.macAddress,
      ip_address: u.address || null,
      voucher_code: u.loginBy && u.loginBy !== 'mac-cookie' ? u.loginBy : null,
      device_type: null,
      downloaded_mb: Math.round(u.downBytes / 1048576),
      uploaded_mb: Math.round(u.upBytes / 1048576),
      started_at: new Date(Date.now() - u.uptimeSeconds * 1000).toISOString(),
      ended_at: null,
    }))
  if (fresh.length) await admin.from('sessions').insert(fresh)

  // Refresh byte counters on sessions that are still running.
  for (const u of live) {
    const id = existingMacs.get(u.macAddress)
    if (!id) continue
    await admin.from('sessions').update({
      downloaded_mb: Math.round(u.downBytes / 1048576),
      uploaded_mb: Math.round(u.upBytes / 1048576),
    }).eq('id', id)
  }
}
