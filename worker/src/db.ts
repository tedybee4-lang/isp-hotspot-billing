// =============================================================================
//  Supabase access for the worker.
//
//  The worker authenticates with the service role, which bypasses RLS. That is
//  correct for a trusted backend process, and only correct because every call
//  here is tenant-scoped in the query itself: a job carries its own isp_id, and a
//  router is always addressed by its node id, never by a browser-supplied one.
//
//  Credentials are decrypted here, in memory, only for as long as a session is
//  open. They are never logged, never written back, and never put in a result.
// =============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret } from './crypto.ts'
import type { JobStore, RouterJob } from './runner.ts'
import type { RouterTarget } from './router-client.ts'
import type { HandlerContext, ProvisioningWork } from './handlers.ts'
import type { StageStatus, DiscoveredPool } from './stages.ts'
import { resolvePppPools, resolveHotspotPool } from './stages.ts'

export interface DbConfig {
  url: string
  serviceRoleKey: string
  /** AES key the Edge Function uses for router credentials. */
  credentialKey: string
  workerName: string
  hostname?: string
  region?: string
  publicIp?: string
  wgAddress?: string
  wgPublicKey?: string
}

export class Db implements JobStore {
  readonly client: SupabaseClient

  constructor(private readonly cfg: DbConfig) {
    this.client = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  /**
   * Claims jobs atomically.
   *
   * `claim_router_jobs()` does the locking in Postgres with
   * `for update skip locked`, so two workers can never be handed the same job.
   * `set_job_worker` records who we are, which is what `complete_router_job`
   * checks before it will record a result.
   */
  async claim(workerName: string, limit: number, kinds: string[] | null): Promise<RouterJob[]> {
    const { error: whoErr } = await this.client.rpc('set_job_worker', { p_worker: workerName })
    if (whoErr) throw new Error(`set_job_worker failed: ${whoErr.message}`)

    const { data, error } = await this.client.rpc('claim_router_jobs', {
      p_worker: workerName,
      p_limit: limit,
      p_lease_secs: 120,
      p_kinds: kinds,
    })
    if (error) throw new Error(`claim_router_jobs failed: ${error.message}`)
    return (data ?? []) as RouterJob[]
  }

  async complete(
    jobId: string, result: Record<string, unknown>,
    method: string | null, durationMs: number,
  ): Promise<void> {
    const { error } = await this.client.rpc('complete_router_job', {
      p_job_id: jobId, p_result: result, p_method: method, p_duration_ms: durationMs,
    })
    if (error) throw new Error(`complete_router_job failed: ${error.message}`)
  }

  async fail(
    jobId: string, errorText: string, result: Record<string, unknown>,
    method: string | null, durationMs: number, retryable: boolean,
  ): Promise<void> {
    const { error } = await this.client.rpc('fail_router_job', {
      p_job_id: jobId,
      p_error: errorText.slice(0, 500),
      p_result: result,
      p_method: method,
      p_duration_ms: durationMs,
      p_retryable: retryable,
    })
    if (error) throw new Error(`fail_router_job failed: ${error.message}`)
  }
/**
 * Loads every router this worker should manage, with credentials decrypted.
 *
 * `host` is preferred over the public IP because a router reached through a VPN
 * tunnel has no useful public address for management; `management_ip` is the
 * fallback for a directly reachable device.
 */
  async targets(): Promise<RouterTarget[]> {
    // The select is explicit, and the result is cast, because supabase-js types
    // an untyped client as `GenericStringError` on the data side. The column
    // list above is the contract; the cast just tells the compiler so.
    const { data, error } = await this.client
      .from('nodes')
      .select('id, isp_id, name, host, management_ip, api_port, api_ssl_port, ' +
        'rest_port, heartbeat_interval_secs, enabled')
      .eq('enabled', true)
    if (error) throw new Error(`loading routers failed: ${error.message}`)

    const nodes = (data ?? []) as unknown as Array<{
      id: string; isp_id: string; name: string
      host: string | null; management_ip: string | null
      api_port: number | null; api_ssl_port: number | null; rest_port: number | null
      heartbeat_interval_secs: number | null; enabled: boolean
    }>

    const out: RouterTarget[] = []
    for (const node of nodes) {
      const address = node.host ?? node.management_ip
      // No address means nothing to connect to. Skipped, never faked.
      if (!address) continue

      const { data: credRow } = await this.client
        .from('router_credentials')
        .select('username_ciphertext, password_ciphertext')
        .eq('node_id', node.id)
        .maybeSingle()
      const creds = credRow as
        | { username_ciphertext: string; password_ciphertext: string }
        | null
      if (!creds) continue

      try {
        out.push({
          nodeId: node.id,
          ispId: node.isp_id,
          name: node.name,
          host: address,
          apiPort: node.api_port ?? 8728,
          apiSslPort: node.api_ssl_port ?? 8729,
          restPort: node.rest_port ?? 8080,
          username: await decryptSecret(creds.username_ciphertext, this.cfg.credentialKey),
          password: await decryptSecret(creds.password_ciphertext, this.cfg.credentialKey),
          timeoutMs: (node.heartbeat_interval_secs ?? 60) * 1000,
        })
      } catch {
        // A credential that will not decrypt is skipped, not guessed at. The
        // router then receives no jobs and the panel shows it as unmanaged,
        // rather than pretending the connection is fine.
        continue
      }
    }
    return out
  }

  /** Registers the worker and reports it alive. */
  async heartbeat(counters: {
    jobs_processed: number; jobs_failed: number
  }): Promise<void> {
    const { error } = await this.client
      .from('network_workers')
      .upsert({
        name: this.cfg.workerName,
        hostname: this.cfg.hostname ?? null,
        public_ip: this.cfg.publicIp ?? null,
        region: this.cfg.region ?? null,
        version: '1.0.0',
        wg_address: this.cfg.wgAddress ?? null,
        wg_public_key: this.cfg.wgPublicKey ?? null,
        status: 'online',
        last_heartbeat_at: new Date().toISOString(),
        jobs_processed: counters.jobs_processed,
        jobs_failed: counters.jobs_failed,
      }, { onConflict: 'name' })
    if (error) throw new Error(`worker heartbeat failed: ${error.message}`)
  }

  /** Records a failure the operator needs to see on the worker card. */
  async markError(message: string): Promise<void> {
    await this.client
      .from('network_workers')
      .update({ last_error: message.slice(0, 500), status: 'degraded' })
      .eq('name', this.cfg.workerName)
  }

  /** Builds the write-back surface the job handlers use. */
  handlerContext(): HandlerContext {
    const c = this.client
    return {
      heartbeat: async (args) => {
        const { error } = await c.rpc('record_router_heartbeat', args)
        if (error) throw new Error(`record_router_heartbeat failed: ${error.message}`)
      },
      saveCapabilities: async (nodeId, ispId, data) => {
        const { error } = await c.from('router_capabilities')
          .upsert({ node_id: nodeId, isp_id: ispId, ...data }, { onConflict: 'node_id' })
        if (error) throw new Error(`saving capabilities failed: ${error.message}`)
      },
      setVoucherSync: async (voucherId, state, detail) => {
        const { error } = await c.from('vouchers').update({
          sync_state: state,
          sync_error: typeof detail.error === 'string' ? detail.error : null,
          synced_at: state === 'synced' ? new Date().toISOString() : null,
          router_user_id: (detail.router_user_id as string | null) ?? null,
        }).eq('id', voucherId)
        if (error) throw new Error(`saving voucher sync failed: ${error.message}`)
      },
      completeSessionCommand: async (commandId, status, detail) => {
        const { error } = await c.from('router_session_commands').update({
          status,
          method: (detail.method as string | null) ?? null,
          error: (detail.note as string | null) ?? null,
          detail,
          completed_at: new Date().toISOString(),
        }).eq('id', commandId)
        if (error) throw new Error(`saving session command failed: ${error.message}`)
      },
      recordDiagnostic: async (nodeId, ispId, row) => {
        const { error } = await c.from('network_diagnostics')
          .insert({ isp_id: ispId, node_id: nodeId, ...row })
        if (error) throw new Error(`saving diagnostic failed: ${error.message}`)
      },
      saveNode: async (nodeId, patch) => {
        const { error } = await c.from('nodes').update(patch).eq('id', nodeId)
        if (error) throw new Error(`saving router failed: ${error.message}`)
      },
      saveCustomer: async (clientId, patch) => {
        const { error } = await c.from('clients').update(patch).eq('id', clientId)
        if (error) throw new Error(`saving customer failed: ${error.message}`)
      },
      saveRadiusAccount: async (row) => {
        const { error } = await c.from('radius_accounts')
          .upsert(row, { onConflict: 'isp_id,username' })
        if (error) throw new Error(`saving radius account failed: ${error.message}`)
      },
      loadProvisioning: (sessionId) => this.loadProvisioning(sessionId),
      advanceStage: async (sessionId, stage, status, extra) => {
        // p_isp_id is passed explicitly because this worker has no auth.uid():
        // the function uses it, together with the netisp.worker GUC that
        // set_job_worker established, to confirm the session belongs to the
        // tenant this job names.
        const { error } = await c.rpc('advance_provisioning_stage', {
          p_session_id: sessionId,
          p_stage: stage,
          p_status: status,
          p_error: extra.error ?? null,
          p_detail: extra.detail ?? {},
          p_skip_reason: extra.skipReason ?? null,
          p_isp_id: extra.ispId,
        })
        // The ordering rule lives in the database. A refusal here means a stage
        // tried to start before one it depends on, and that must surface rather
        // than be logged and ignored.
        if (error) throw new Error(`stage ${stage} -> ${status} refused: ${error.message}`)
      },
      recordBackup: async (sessionId, row) => {
        const { error } = await c.rpc('record_router_backup', {
          p_session_id: sessionId,
          p_node_id: row.nodeId,
          p_filename: row.filename,
          p_kind: row.kind,
          p_routeros_version: row.routerosVersion ?? null,
          p_size_bytes: row.sizeBytes ?? null,
          p_status: 'succeeded',
        })
        if (error) throw new Error(`recording backup failed: ${error.message}`)
      },
      setSessionState: async (sessionId, state, error) => {
        const { error: e } = await c.from('provisioning_sessions').update({
          state,
          last_error: error ?? null,
          ...(state === 'online' ? { completed_at: new Date().toISOString() } : {}),
        }).eq('id', sessionId)
        if (e) throw new Error(`saving session state failed: ${e.message}`)
      },
      enqueueNextPass: async (sessionId, nodeId, ispId, pass) => {
        // The EXISTING queue. The key carries the pass number so each pass is a
        // distinct job, while a duplicate delivery of the same pass collapses.
        const { data, error } = await c.rpc('enqueue_router_job', {
          p_node_id: nodeId,
          p_kind: 'provision',
          p_payload: { session_id: sessionId, pass },
          p_idempotency_key: `provision:${sessionId}:p${pass + 1}`,
          p_priority: 5,
          p_max_attempts: 8,
          p_isp_id: ispId,
        })
        if (error) throw new Error(`queueing next pass failed: ${error.message}`)
        if (data && (data as { ok?: boolean }).ok === false) {
          throw new Error(`queueing next pass refused: `
            + `${(data as { error?: string }).error ?? 'unknown'}`)
        }
      },
    }
  }

// APPEND_DB_HERE
  /**
   * Loads everything a provisioning pass needs, in one round trip.
   *
   * The stage ORDER comes from the database catalogue, not from this file. The
   * worker's registry is checked against it by a test, and the worker is not
   * allowed to decide what runs next - that is what stops a stage running before
   * the one it depends on.
   */
  async loadProvisioning(sessionId: string): Promise<ProvisioningWork | null> {
    const c = this.client

    const { data: sessionRow, error: sErr } = await c
      .from('provisioning_sessions')
      .select('id, isp_id, node_id, role, wan_interface, hotspot_interfaces, '
        + 'pppoe_interfaces, management_interfaces, wizard_answers')
      .eq('id', sessionId)
      .maybeSingle()
    // The select is the contract; the cast only tells the compiler so. supabase-js
    // types an untyped client as GenericStringError on the data side.
    const session = sessionRow as unknown as {
      id: string; isp_id: string; node_id: string | null
      role: string; wan_interface: string | null
      hotspot_interfaces: string[]; pppoe_interfaces: string[]
      management_interfaces: string[] | null
      wizard_answers: Record<string, string> | null
    }
    if (sErr) throw new Error(`loading provisioning session failed: ${sErr.message}`)
    if (!session) return null

    const [stagesRes, plansRes, orderRes, capsRes] = await Promise.all([
      c.from('provisioning_stages')
        .select('stage, status').eq('session_id', sessionId),
      c.from('plans')
        .select('id, name, kind, speed_down, speed_up, shared_users, data_limit, is_active')
        .eq('isp_id', session.isp_id),
      c.rpc('provisioning_stage_order'),
      // The pools and networks the WORKER's own capability survey found. This is
      // the authoritative source for address allocation: the operator does not
      // retype ranges the router already has, and does not get asked to.
      session.node_id
        ? c.from('router_capabilities').select('pools, addresses').eq('node_id', session.node_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (stagesRes.error) throw new Error(`loading stages failed: ${stagesRes.error.message}`)
    if (plansRes.error) throw new Error(`loading plans failed: ${plansRes.error.message}`)

    const stageStatuses: Record<string, StageStatus> = {}
    for (const row of (stagesRes.data ?? []) as Array<{ stage: string; status: string }>) {
      stageStatuses[row.stage] = row.status as StageStatus
    }

    // The catalogue order is authoritative. There is deliberately NO alphabetical
    // fallback: guessing an order can run a stage before the one it depends on,
    // which is worse than refusing to start.
    const order = (orderRes.data as string[] | null) ?? []
    if (order.length === 0) {
      throw new Error('provisioning_stage_order() returned nothing, so the stage order '
        + 'is unknown. Refusing to guess an order.')
    }

    // Only customers the BILLING side has already made active. This decides what
    // to mirror onto the router and nothing else - it cannot activate anyone,
    // because nothing here writes back to billing.
    const { data: customers } = await c
      .from('clients')
      .select('id, username, status, plan_name, expires_at')
      .eq('isp_id', session.isp_id)

    const active = ((customers ?? []) as Array<{
      id: string; username: string; status: string
      plan_name: string | null; expires_at: string | null
    }>).filter((row) =>
      row.status === 'active' && (!row.expires_at || new Date(row.expires_at) > new Date()))

    const answers = (session.wizard_answers ?? {}) as Record<string, string>

    // ── Address allocation ─────────────────────────────────────────────────
    //
    // Precedence, and the reason for it:
    //
    //   1. The router's OWN discovered pools. These are what the device actually
    //      has, and using them is what stops the operator being asked to retype
    //      ranges the router already knows - and what stops provisioning failing
    //      with "assign an address range" on a router that has perfectly good
    //      ones.
    //   2. An explicit wizard answer OVERRIDES discovery, because the operator
    //      knows about a network the survey cannot see (a routed prefix coming
    //      from upstream, for instance) and their choice wins.
    //
    // Nothing is invented. If neither source yields a usable range the stage
    // fails with a reason, which is the correct outcome: a guessed range that
    // overlaps the LAN takes the router down.
    const caps = capsRes.data as unknown as {
      pools?: Array<Record<string, string>> | null
      addresses?: Array<Record<string, string>> | null
    } | null

    const pools: DiscoveredPool[] = (caps?.pools ?? []).map((row) => ({
      name: row.name ?? '',
      ranges: row.ranges ?? '',
      nextPool: row['next-pool'] ?? null,
    })).filter((p) => p.name !== '')

    const discoveredPpp = resolvePppPools(pools)
    const discoveredHs = resolveHotspotPool(pools, { exclude: discoveredPpp.source })

    const pppLocal = answers['ppp_local'] || discoveredPpp.local
    const pppRemote = answers['ppp_remote'] || discoveredPpp.remote
    const hotspotPool = answers['hotspot_pool'] || discoveredHs.pool

    return {
      session: {
        id: session.id,
        ispId: session.isp_id,
        nodeId: session.node_id ?? '',
        role: (session.role as 'hotspot' | 'pppoe' | 'both') ?? 'hotspot',
        tag: sessionId.slice(0, 8),
        wanInterface: session.wan_interface ?? null,
        hotspotInterfaces: session.hotspot_interfaces ?? [],
        pppoeInterfaces: session.pppoe_interfaces ?? [],
        managementInterfaces: session.management_interfaces ?? [],
        tunnelRequired: answers['tunnel'] === 'wireguard',
        dns: answers['dns'] ? String(answers['dns']).split(',').filter(Boolean) : [],
        radiusServer: answers['radius_server'] ?? null,
        radiusEnabled: answers['radius_enabled'] === 'true',
        // A secret is never stored in the session row, and none is read here.
        radiusSecret: null,
        sessionTimeoutMin: Number(answers['session_timeout_min'] ?? 30),
        idleTimeoutMin: Number(answers['idle_timeout_min'] ?? 5),
        pppLocal: pppLocal ?? null,
        pppRemote: pppRemote ?? null,
        hotspotPool: hotspotPool ?? null,
      },
      stageStatuses,
      stageOrder: order,
      plans: ((plansRes.data ?? []) as Array<{
        id: string; name: string; kind: string
        speed_down: string; speed_up: string
        shared_users: number; data_limit: string | null; is_active: boolean
      }>).map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind as 'hotspot' | 'pppoe' | 'fiber',
        speed_down: p.speed_down,
        speed_up: p.speed_up,
        shared_users: p.shared_users ?? 1,
        data_limit: p.data_limit ?? null,
        is_active: p.is_active !== false,
      })),
      // No credential is read: subscribers authenticate through RADIUS, so the
      // platform never needs a subscriber password to create the account.
      customers: active.map((row) => ({
        id: row.id,
        username: row.username,
        password_plain: null,
        plan_name: row.plan_name,
        is_active: true,
      })),
    }
  }
}
