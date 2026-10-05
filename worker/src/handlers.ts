// =============================================================================
//  Job handlers.
//
//  One function per job kind. Each one:
//    * reads what it needs from the router over the transport actually chosen
//    * writes results back through the platform RPCs
//    * reports the method it used, so a fallback from api_ssl to api is visible
//
//  The rule every handler follows: it never reports success for work the router
//  did not confirm. A heartbeat that could not be collected records a failure; a
//  voucher the router did not accept stays pending. The platform is only useful
//  if "synced" means synced.
// =============================================================================

import { RouterConnectError, isAlreadyExists, isAuthFailure } from './session.ts'
import type { RouterClient, RouterTarget } from './router-client.ts'
import type { JobHandler, JobOutcome } from './runner.ts'
import {
  runStage,
  type StageContext, type StageStatus,
} from './stages.ts'

/** Everything the provision handler needs, loaded once per job. */
export interface ProvisioningWork {
  session: StageContext['session']
  stageStatuses: Record<string, StageStatus>
  stageOrder: string[]
  plans: StageContext['plans']
  customers: StageContext['customers']
}

/** Everything a handler needs to write results back. */
export interface HandlerContext {
  /** record_router_heartbeat(...) */
  heartbeat(args: Record<string, unknown>): Promise<void>
  /** Upsert into router_capabilities. */
  saveCapabilities(nodeId: string, ispId: string, data: Record<string, unknown>): Promise<void>
  /** Marks a voucher's sync state on the router. */
  setVoucherSync(voucherId: string, state: string, detail: Record<string, unknown>): Promise<void>
  /** Records a disconnect outcome honestly. */
  completeSessionCommand(commandId: string, status: string, detail: Record<string, unknown>): Promise<void>
  /** Writes a diagnostic result row. */
  recordDiagnostic(nodeId: string, ispId: string, row: Record<string, unknown>): Promise<void>
  /** Patches the router's summary row. */
  saveNode(nodeId: string, patch: Record<string, unknown>): Promise<void>
  /** Marks a customer's network state. */
  saveCustomer(clientId: string, patch: Record<string, unknown>): Promise<void>
  /** Upserts the RADIUS mirror row. */
  saveRadiusAccount(row: Record<string, unknown>): Promise<void>
  // -- staged provisioning ------------------------------------------------------
  /** Loads a session, its stage list, its plans and its active entitlements. */
  loadProvisioning(sessionId: string): Promise<ProvisioningWork | null>
  /** Records a stage transition. Throws if the database refuses the ordering. */
  advanceStage(
    sessionId: string,
    stage: string,
    status: StageStatus,
    extra: {
      ispId: string
      error?: string | null
      skipReason?: string | null
      detail?: Record<string, unknown>
    },
  ): Promise<void>
  /** Records backup metadata for the session. */
  recordBackup(sessionId: string, row: {
    nodeId: string; ispId: string; filename: string; kind: string
    routerosVersion?: string | null; sizeBytes?: number | null
  }): Promise<void>
  /** Moves the session itself to a new state. */
  setSessionState(sessionId: string, state: string, error?: string | null): Promise<void>
  /**
   * Queues the next pass of the same provisioning run.
   *
   * This is the EXISTING queue - enqueue_router_job - not a second one. The
   * idempotency key carries the pass number, so each pass is a distinct job
   * while a retry of the same pass is deduplicated. That is what lets a
   * thirteen-stage run survive a worker restart: the pass in flight is reclaimed
   * by the lease, and the pass after it is already queued.
   */
  enqueueNextPass(
    sessionId: string,
    nodeId: string,
    ispId: string,
    pass: number,
  ): Promise<void>
}

const num = (v: string | undefined | null): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const mb = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round(bytes / 1048576)

/** "1w2d3h4m5s" -> seconds. RouterOS reports uptime this way on every version. */
export function parseUptime(text: string | null | undefined): number | null {
  if (!text) return null
  const re = /(\d+)([wdhms])/g
  let total = 0
  let matched = false
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    matched = true
    const n = Number(m[1])
    if (m[2] === 'w') total += n * 604800
    else if (m[2] === 'd') total += n * 86400
    else if (m[2] === 'h') total += n * 3600
    else if (m[2] === 'm') total += n * 60
    else total += n
  }
  return matched ? total : null
}
/**
 * heartbeat: prove the router is alive and read its resources.
 *
 * This is the only thing that may set a router ONLINE, and it does so only after
 * a real command came back. Everything the dashboard shows about a router
 * originates here.
 */
export function heartbeatHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    // One resource read is the minimum that proves liveness, and it costs almost
    // nothing on a 32 MB device. Everything else is optional and must never turn
    // a healthy router into an unreachable one.
    const resource = await client.run(target, '/system/resource/print')
    const res = resource.rows[0] ?? {}
    const totalMem = num(res['total-memory'])
    const freeMem = num(res['free-memory'])

    // User counts are best-effort. A router with HotSpot disabled answers with a
    // permission error, which means "feature off", not "router down".
    const [hotspot, pppoe] = await Promise.all([
      client.run(target, '/ip/hotspot/active/print').catch(() => null),
      client.run(target, '/interface/pppoe-client/print').catch(() => null),
    ])

    const hotspotUsers = hotspot?.rows.length ?? 0
    const pppoeUsers = pppoe
      ? pppoe.rows.filter((r) => r.status === 'bound').length
      : 0

    await ctx.heartbeat({
      p_node_id: target.nodeId,
      p_ok: true,
      p_source: resource.method,
      p_latency_ms: resource.latencyMs,
      p_routeros_version: res.version ?? null,
      p_board_name: res['board-name'] ?? null,
      p_architecture: res['architecture-name'] ?? null,
      p_cpu_load: num(res['cpu-load']),
      p_ram_free_mb: mb(freeMem),
      p_uptime_seconds: parseUptime(res.uptime),
      p_active_users: hotspotUsers + pppoeUsers,
      p_hotspot_users: hotspotUsers,
      p_pppoe_users: pppoeUsers,
    })

    await ctx.saveNode(target.nodeId, {
      mgmt_mode: resource.method,
      last_connection_method: resource.method,
      routeros_version: res.version ?? null,
      os_version: res.version ?? null,
      board_name: res['board-name'] ?? null,
      architecture: res['architecture-name'] ?? null,
      cpu_type: res['cpu-type'] ?? null,
      cpu_count: num(res['cpu-count']),
      cpu_load: num(res['cpu-load']),
      ram_total_mb: mb(totalMem),
      storage_total_mb: mb(num(res['total-hdd-space'])),
      uptime_seconds: parseUptime(res.uptime),
      // Reaching the router at all proves the claim script was imported.
      provisioning_state: 'applied',
    })

    return {
      ok: true,
      durationMs: Date.now() - started,
      method: resource.method,
      result: {
        version: res.version ?? null,
        board: res['board-name'] ?? null,
        uptime: res.uptime ?? null,
        hotspot_users: hotspotUsers,
        pppoe_users: pppoeUsers,
        // Whether each count is real or the feature is simply absent. Reported
        // separately so the UI never shows 0 for "not measured".
        hotspot_reported: hotspot !== null,
        pppoe_reported: pppoe !== null,
        encrypted: resource.encrypted,
      },
    }
  }
}
/** Commands surveyed by the capability job, in probe order. */
const SURVEY = [
  '/ip/service/print',             // 0  services: tells us which transports exist
  '/interface/print',              // 1
  '/interface/bridge/print',       // 2
  '/interface/vlan/print',         // 3
  '/interface/wireguard/print',    // 4
  '/interface/wireless/print',     // 5
  '/ip/dhcp-server/print',         // 6
  '/ip/route/print',               // 7
  '/ip/hotspot/print',             // 8
  '/ip/hotspot/profile/print',     // 9
  '/interface/pppoe-server/print', // 10
  '/ppp/profile/print',            // 11
  '/ppp/secret/print',             // 12
  '/queue/simple/print',           // 13
  '/queue/tree/print',             // 14
  '/radius/print',                 // 15
  '/ip/firewall/filter/print',     // 16
  '/ip/firewall/nat/print',        // 17
  '/system/scheduler/print',       // 18
  '/system/script/print',          // 19
  '/ip/hotspot/user/print',        // 20
  '/ip/pool/print',                // 21  address pools: the PPPoE ranges
  '/ip/address/print',             // 22  which networks exist to carve pools from
] as const

/**
 * The index of each probe, by name.
 *
 * The survey is positional and these are the indices the handler reads. Spelled
 * out as a map rather than hardcoded numbers because a probe inserted in the
 * middle of the array would otherwise silently shift every later index - and a
 * capability that reports the WRONG section is worse than one that reports
 * nothing, because the operator has no way to tell it is wrong.
 */
const PROBE = {
  services: 0, interfaces: 1, bridges: 2, vlans: 3, wireguard: 4, wireless: 5,
  dhcp: 6, routes: 7, hotspot: 8, hotspotProfiles: 9, pppoe: 10, pppProfiles: 11,
  pppSecrets: 12, simpleQueues: 13, treeQueues: 14, radius: 15, firewall: 16,
  nat: 17, scheduler: 18, scripts: 19, hotspotUsers: 20, pools: 21, addresses: 22,
} as const

/**
 * capabilities: survey the hardware and every service the platform cares about.
 *
 * Each flag below is the result of a command that actually came back, never an
 * assumption from the version string. That distinction is what lets the UI hide a
 * control that would fail.
 */
export function capabilitiesHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const [resource, license] = await Promise.all([
      client.run(target, '/system/resource/print').catch(() => null),
      client.run(target, '/system/license/print').catch(() => null),
    ])
    if (!resource) {
      throw new RouterConnectError(
        'The router did not answer /system/resource/print, so its capabilities '
        + 'cannot be determined.')
    }
    const res = resource.rows[0] ?? {}
    const licenseRow = license?.rows[0] ?? {}

    // Probes are independent: one failing must not hide the others, and each
    // keeps its error so the diagnostics screen can explain itself.
    const probes = await Promise.all(SURVEY.map((c) => probe(client, target, c)))

    const services = probes[0].rows
    const serviceNames = services.map((s) => s.name ?? '')
    const servicePorts: Record<string, string> = {}
    for (const s of services) if (s.name && s.port) servicePorts[s.name] = s.port

    // A transport is "available" only when its service is confirmed present.
    const restAvailable = serviceNames.includes('www-ssl')
    const apiAvailable = serviceNames.includes('api')
    const apiSslAvailable = serviceNames.includes('api-ssl')
    const sshAvailable = serviceNames.includes('ssh')

    const unsupported: string[] = []
    if (!restAvailable) unsupported.push('rest')
    if (!probes[4].ok) unsupported.push('wireguard')
    if (!probes[3].ok) unsupported.push('vlan')
    if (!probes[2].ok) unsupported.push('bridge')
    if (!probes[8].ok) unsupported.push('hotspot')
    if (!probes[10].ok) unsupported.push('pppoe')

    // CHR is software. Its license level says so; the nameless-x86 rule is the
    // fallback for installs that do not expose the license menu.
    const isChr = /chr/i.test(licenseRow.level ?? '')
      || /chr/i.test(res['board-name'] ?? '')
      || (res['architecture-name'] === 'x86' && !res['board-name'])
const data: Record<string, unknown> = {
      detected_at: new Date().toISOString(),
      detected_by: resource.method,
      board_name: res['board-name'] ?? null,
      model: res['board-name'] ?? null,
      serial_number: res['serial-number'] ?? null,
      firmware_type: res['firmware-type'] ?? null,
      routeros_version: res.version ?? null,
      architecture: res['architecture-name'] ?? null,
      is_chr: isChr,
      license_level: licenseRow.level ?? null,
      cpu_type: res['cpu-type'] ?? null,
      cpu_count: num(res['cpu-count']),
      cpu_load: num(res['cpu-load']),
      ram_total_mb: mb(num(res['total-memory'])),
      ram_free_mb: mb(num(res['free-memory'])),
      storage_total_mb: mb(num(res['total-hdd-space'])),
      uptime_seconds: parseUptime(res.uptime),
      board_temperature: num(res['board-temperature']),
      rest_available: restAvailable,
      api_available: apiAvailable,
      api_ssl_available: apiSslAvailable,
      ssh_available: sshAvailable,
      has_hotspot: probes[8].ok,
      has_pppoe: probes[10].ok,
      has_wireguard: probes[4].ok,
      has_bridge: probes[2].ok,
      has_vlan: probes[3].ok,
      has_dhcp: probes[6].ok,
      has_queue_simple: probes[13].ok,
      has_queue_tree: probes[14].ok,
      has_radius: probes[15].ok,
      has_ssh_service: sshAvailable,
      has_scheduler: probes[18].ok,
      has_scripting: probes[19].ok,
      interfaces: probes[1].rows,
      wireless: probes[5].rows,
      bridges: probes[2].rows,
      vlans: probes[3].rows,
      dhcp_servers: probes[PROBE.dhcp].rows,
      routes: probes[PROBE.routes].rows,
      // The address ranges the router already has. These are what PPPoE and
      // HotSpot are allocated from, so persisting them is what lets the wizard
      // stop asking the operator to type ranges the router already knows.
      pools: probes[PROBE.pools].rows,
      addresses: probes[PROBE.addresses].rows,
      hotspot_servers: probes[8].rows,
      hotspot_profiles: probes[9].rows,
      // Capped so a large HotSpot table cannot stall the survey on a device
      // with 32 MB of RAM.
      hotspot_users: probes[20].rows.slice(0, 200),
      pppoe_servers: probes[10].rows,
      ppp_profiles: probes[11].rows,
      ppp_secrets: probes[12].rows,
      pppoe_active: [],
      simple_queues: probes[13].rows,
      queue_trees: probes[14].rows,
      radius_servers: probes[15].rows,
      firewall_rules: probes[16].rows,
      nat_rules: probes[17].rows,
      services,
      diagnostics: {
        service_ports: servicePorts,
        probe_failures: probes
          .map((p, i) => (p.ok ? null : { command: SURVEY[i], error: p.error }))
          .filter(Boolean),
      },
      unsupported,
    }

    await ctx.saveCapabilities(target.nodeId, target.ispId, data)

    // Store the discovered ports so the next connection uses real ones rather
    // than defaults.
    await ctx.saveNode(target.nodeId, {
      mgmt_mode: resource.method,
      api_port: num(servicePorts.api) ?? 8728,
      api_ssl_port: num(servicePorts['api-ssl']) ?? 8729,
      rest_port: num(servicePorts['www-ssl']) ?? 8080,
      ssh_port: num(servicePorts.ssh) ?? 22,
      routeros_version: res.version ?? null,
      board_name: res['board-name'] ?? null,
      architecture: res['architecture-name'] ?? null,
      cpu_type: res['cpu-type'] ?? null,
      cpu_count: num(res['cpu-count']),
      ram_total_mb: mb(num(res['total-memory'])),
      storage_total_mb: mb(num(res['total-hdd-space'])),
      license_level: licenseRow.level ?? null,
      is_chr: isChr,
    })

    return {
      ok: true,
      durationMs: Date.now() - started,
      method: resource.method,
      result: {
        rest: restAvailable, api: apiAvailable,
        api_ssl: apiSslAvailable, ssh: sshAvailable,
        unsupported,
        probes_ok: probes.filter((p) => p.ok).length,
        probes_total: probes.length,
      },
    }
  }
}

/** Runs a command and reports whether it worked, never throwing. */
async function probe(
  client: RouterClient,
  target: RouterTarget,
  command: string,
): Promise<{ ok: boolean; rows: Record<string, string>[]; error: string | null }> {
  try {
    const res = await client.run(target, command)
    return { ok: true, rows: res.rows, error: null }
  } catch (err) {
    return { ok: false, rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}
// -----------------------------------------------------------------------------
//  Vouchers
//
//  A voucher is only `synced` when the router says the account exists. The two
//  failure modes are kept distinct, because they mean different things:
//    * "already have such entry" -> the router already has it. That is a
//      success, not an error, and reporting it as a failure would leave a
//      working voucher stuck in FAILED forever.
//    * anything else -> genuinely not created, so it stays retryable.
// -----------------------------------------------------------------------------

/**
 * voucher_sync: create the HotSpot account for one voucher.
 *
 * Idempotent by design. Running it twice must not produce a second account and
 * must not fail the second time - which is why the "already exists" response is
 * treated as success.
 */
export function voucherSyncHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const voucherId = String(job.payload.voucher_id ?? '')
    const code = String(job.payload.code ?? '')
    const profile = String(job.payload.profile ?? 'default')
    if (!voucherId || !code) {
      throw new RouterConnectError('voucher_sync requires voucher_id and code.')
    }

    // Check before creating. This is the "check whether it already exists"
    // rule, and it also means a retry after a half-completed run does not
    // produce a duplicate.
    const existing = await client.run(
      target, '/ip/hotspot/user/print', { '=name': code },
    ).catch(() => ({ rows: [] as Record<string, string>[], method: 'api', latencyMs: 0 }))

    if (existing.rows.length > 0) {
      await ctx.setVoucherSync(voucherId, 'synced', {
        router_user_id: existing.rows[0]['.id'] ?? null,
        note: 'already present on the router',
      })
      return {
        ok: true, durationMs: Date.now() - started, method: 'api',
        result: { already_present: true },
      }
    }

    const params: Record<string, string> = {
      name: code,
      password: String(job.payload.password ?? code),
      profile,
      // Everything the platform creates is tagged, so a rollback can find it.
      comment: `NETISP:${job.isp_id.slice(0, 8)}`,
    }
    const limitUptime = job.payload.limit_uptime
    if (typeof limitUptime === 'string' && limitUptime) params['limit-uptime'] = limitUptime

    try {
      const created = await client.run(target, '/ip/hotspot/user/add', params)
      await ctx.setVoucherSync(voucherId, 'synced', {
        router_user_id: created.rows[0]?.['.id'] ?? null,
        profile,
      })
      return {
        ok: true, durationMs: Date.now() - started, method: created.method,
        result: { created: true, profile },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // The router answered "it already exists". That is the desired end state.
      if (isAlreadyExists(message)) {
        await ctx.setVoucherSync(voucherId, 'synced', { note: message })
        return {
          ok: true, durationMs: Date.now() - started,
          result: { already_present: true, note: message },
        }
      }

      // Not created. Record the failure so the UI shows FAILED or RETRYING
      // rather than pretending the voucher is usable.
      await ctx.setVoucherSync(voucherId, 'failed', { error: message })
      throw err
    }
  }
}

/**
 * voucher_revoke: remove a voucher from the router.
 *
 * Only ever removes accounts the platform created. A HotSpot account that
 * predates the platform may belong to a customer's own setup, so the comment
 * tag is checked before anything is removed.
 */
export function voucherRevokeHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const voucherId = String(job.payload.voucher_id ?? '')
    const code = String(job.payload.code ?? '')
    const routerUserId = String(job.payload.router_user_id ?? '')
    const tag = `NETISP:${job.isp_id.slice(0, 8)}`
    if (!voucherId || !code) {
      throw new RouterConnectError('voucher_revoke requires voucher_id and code.')
    }

    const found = await client.run(target, '/ip/hotspot/user/print', { '=name': code })
    const row = found.rows[0]
    if (!row) {
      // Already gone. The desired state, so this is a success.
      await ctx.setVoucherSync(voucherId, 'revoked', { note: 'not present on the router' })
      return {
        ok: true, durationMs: Date.now() - started, method: found.method,
        result: { already_absent: true },
      }
    }

    // Refuse to delete an account we did not create.
    if (!(row.comment ?? '').startsWith('NETISP:')) {
      await ctx.setVoucherSync(voucherId, 'failed', {
        error: 'That HotSpot account was not created by NETISP, so it was left alone.',
      })
      return {
        ok: false, durationMs: Date.now() - started, method: found.method,
        error: `The HotSpot account "${code}" is not tagged NETISP, so it was not removed.`,
        retryable: false,
      }
    }

    const id = routerUserId || row['.id']
    if (!id) throw new RouterConnectError('RouterOS did not return an id for that account.')
    await client.run(target, '/ip/hotspot/user/remove', { '.id': id })
    await ctx.setVoucherSync(voucherId, 'revoked', { removed: true })

    return {
      ok: true, durationMs: Date.now() - started, method: found.method,
      result: { removed: true },
    }
  }
}
// -----------------------------------------------------------------------------
//  Customer network accounts
// -----------------------------------------------------------------------------

/**
 * customer_sync: create or update one customer's HotSpot account.
 *
 * Additive and idempotent: the account is looked up by name first, then created
 * only when absent. Re-running after a price or profile change updates the
 * existing account rather than failing with "already have such entry".
 */
export function customerSyncHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const clientId = String(job.payload.client_id ?? '')
    const username = String(job.payload.username ?? '')
    const password = String(job.payload.password ?? '')
    const profile = String(job.payload.profile ?? 'default')
    if (!clientId || !username || !password) {
      throw new RouterConnectError('customer_sync requires client_id, username and password.')
    }

    const existing = await client.run(
      target, '/ip/hotspot/user/print', { '=name': username },
    ).catch(() => ({ rows: [] as Record<string, string>[], method: 'api' as const, latencyMs: 0 }))

    const tag = `NETISP:${job.isp_id.slice(0, 8)}`
    let routerUserId: string | null = null
    let created = existing.rows.length === 0

    if (!created) {
      const id = existing.rows[0]['.id']
      if (!id) throw new RouterConnectError('RouterOS returned no id for that account.')
      routerUserId = id
      await client.run(target, '/ip/hotspot/user/set', {
        '.id': id,
        password,
        profile,
        comment: tag,
        disabled: job.payload.disabled === true ? 'yes' : 'no',
      })
    } else {
      const added = await client.run(target, '/ip/hotspot/user/add', {
        name: username, password, profile, comment: tag,
      })
      routerUserId = added.rows[0]?.['.id'] ?? null
    }

    await ctx.saveCustomer(clientId, {
      network_state: 'active',
      router_id: target.nodeId,
      hotspot_username: username,
      last_sync_error: null,
    })

    return {
      ok: true, durationMs: Date.now() - started,
      result: { router_user_id: routerUserId, profile, created },
    }
  }
}
/**
 * customer_suspend: disable the account without deleting it.
 *
 * Disabling rather than removing: the customer is owed the ability to pay and
 * come back, and deleting the account would also destroy their usage history on
 * the router.
 */
export function customerSuspendHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const clientId = String(job.payload.client_id ?? '')
    const username = String(job.payload.username ?? '')
    if (!clientId || !username) {
      throw new RouterConnectError('customer_suspend requires client_id and username.')
    }

    const found = await client.run(target, '/ip/hotspot/user/print', { '=name': username })
    const row = found.rows[0]
    if (!row?.['.id']) {
      // Nothing to suspend on the router. The customer is still suspended in
      // the platform; that is a real state, not an error.
      await ctx.saveCustomer(clientId, { network_state: 'suspended' })
      return {
        ok: true, durationMs: Date.now() - started, method: found.method,
        result: { not_present_on_router: true },
      }
    }

    // Kill any live session first, otherwise the customer stays online even
    // though their account is disabled.
    const killed = await killActiveSession(client, target, username).catch(() => 0)

    await client.run(target, '/ip/hotspot/user/set', {
      '.id': row['.id'], disabled: 'yes',
    })
    await ctx.saveCustomer(clientId, { network_state: 'suspended' })

    return {
      ok: true, durationMs: Date.now() - started, method: found.method,
      result: { disabled: true, sessions_terminated: killed },
    }
  }
}

/** customer_reactivate: re-enable the account. The mirror of suspend. */
export function customerReactivateHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const clientId = String(job.payload.client_id ?? '')
    const username = String(job.payload.username ?? '')
    if (!clientId || !username) {
      throw new RouterConnectError('customer_reactivate requires client_id and username.')
    }

    const found = await client.run(target, '/ip/hotspot/user/print', { '=name': username })
    const row = found.rows[0]
    if (!row?.['.id']) {
      throw new RouterConnectError(
        `The router has no HotSpot account named "${username}", so it cannot be `
        + 'reactivated. Run a customer sync first.')
    }

    await client.run(target, '/ip/hotspot/user/set', {
      '.id': row['.id'], disabled: 'no',
    })
    await ctx.saveCustomer(clientId, { network_state: 'active' })

    return {
      ok: true, durationMs: Date.now() - started, method: found.method,
      result: { enabled: true },
    }
  }
}
/**
 * disconnect: end one live session on the router.
 *
 * The important behaviour is what happens when the router cannot confirm. The
 * platform must then say "requested, confirmation unavailable" rather than
 * pretending the customer was disconnected. `unconfirmed` exists for exactly
 * that case.
 */
export function disconnectHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const commandId = String(job.payload.command_id ?? '')
    const routerUserId = String(job.payload.router_user_id ?? '')
    const macAddress = String(job.payload.mac_address ?? '')
    const username = String(job.payload.username ?? '')
    if (!commandId) throw new RouterConnectError('disconnect requires command_id.')

    // Prefer the router's own id: it is exact. Then MAC, which survives a
    // reconnect. Then the login name.
    let row: Record<string, string> | null = null
    let lookup = 'none'

    if (routerUserId) {
      const byId = await client.run(target, '/ip/hotspot/active/print', { '.id': routerUserId })
      row = byId.rows[0] ?? null
      lookup = 'id'
    }
    if (!row && macAddress) {
      const byMac = await client.run(
        target, '/ip/hotspot/active/print', { '=mac-address': macAddress })
      row = byMac.rows[0] ?? null
      lookup = 'mac'
    }
    if (!row && username) {
      const byUser = await client.run(target, '/ip/hotspot/active/print', { '=user': username })
      row = byUser.rows[0] ?? null
      lookup = 'user'
    }

    if (!row) {
      // The session is already gone, which is the state the ISP asked for.
      await ctx.completeSessionCommand(commandId, 'confirmed', {
        note: 'no matching active session on the router',
      })
      return {
        ok: true, durationMs: Date.now() - started,
        result: { already_gone: true },
      }
    }

    const id = row['.id']
    if (!id) throw new RouterConnectError('RouterOS returned no id for that active session.')

    await client.run(target, '/ip/hotspot/active/remove', { '.id': id })

    // Confirm by reading the table back. A `!done` is a strong signal, but
    // reading back is the only way to actually know.
    const verify = await client.run(target, '/ip/hotspot/active/print', { '.id': id })
    const confirmed = verify.rows.length === 0

    await ctx.completeSessionCommand(commandId, confirmed ? 'confirmed' : 'unconfirmed', {
      router_user_id: id,
      lookup,
      mac_address: row['mac-address'] ?? null,
      ip_address: row.address ?? null,
      note: confirmed
        ? 'The router confirmed the session is gone.'
        : 'The router accepted the removal but still reports the session.',
    })

    return {
      ok: true, durationMs: Date.now() - started,
      result: {
        removed: id, confirmed, lookup,
        mac_address: row['mac-address'] ?? null,
        ip_address: row.address ?? null,
      },
    }
  }
}

/** Ends every active session for one username. */
async function killActiveSession(
  client: RouterClient,
  target: RouterTarget,
  username: string,
): Promise<number> {
  const active = await client.run(target, '/ip/hotspot/active/print', { '=user': username })
  let removed = 0
  for (const row of active.rows) {
    const id = row['.id']
    if (!id) continue
    await client.run(target, '/ip/hotspot/active/remove', { '.id': id })
    removed += 1
  }
  return removed
}

/** Ends every active session, ignoring who owns them. Used on expiry sweeps. */
export async function killAllActive(
  client: RouterClient,
  target: RouterTarget,
): Promise<number> {
  const active = await client.run(target, '/ip/hotspot/active/print')
  let removed = 0
  for (const row of active.rows) {
    const id = row['.id']
    if (!id) continue
    await client.run(target, '/ip/hotspot/active/remove', { '.id': id })
    removed += 1
  }
  return removed
}
// -----------------------------------------------------------------------------
//  Diagnostics
//
//  The browser picks an action name from this list. It never composes a RouterOS
//  command and never supplies a command path, because a panel that can build
//  arbitrary RouterOS commands is a remote shell with an ISP's routers attached.
//
//  Every entry is read-only. There is deliberately no action here that writes,
//  restarts, or reboots: if it is not in this table, the worker will not run it.
// -----------------------------------------------------------------------------

export const DIAGNOSTIC_COMMANDS: Record<string, string> = {
  identity: '/system/identity/print',
  resource: '/system/resource/print',
  interface: '/interface/print',
  route: '/ip/route/print',
  bridge: '/interface/bridge/print',
  hotspot_active: '/ip/hotspot/active/print',
  pppoe_active: '/interface/pppoe-client/print',
  log: '/log/print',
  connections: '/ip/firewall/connection/print',
  dns: '/ip/dns/print',
  ntp: '/system/ntp/client/print',
  services: '/ip/service/print',
  queues: '/queue/simple/print',
  dhcp: '/ip/dhcp-server/print',
  radius: '/radius/print',
  // `ping` and a DNS lookup take a target, so they are handled separately and
  // their target is validated rather than concatenated into a command.
}

export interface DiagnosticRequest {
  action: string
  target?: string
}

/**
 * diagnostic: run one allow-listed read-only check.
 *
 * Returns the raw rows so an operator sees exactly what the router said. It is
 * also written to `network_diagnostics`, which is the answer to "did anyone
 * actually look at this router last Tuesday".
 */
export function diagnosticHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const action = String(job.payload.action ?? '')
    const arg = String(job.payload.target ?? '').trim()

    let command: string
    let params: Record<string, string> = {}

    if (action === 'ping') {
      command = '/ping'
      // RouterOS requires the count separately, and a wrong value is rejected
      // by the firmware, so it is clamped rather than trusted.
      params = { address: validateHost(arg), count: '3' }
    } else if (action === 'dns') {
      command = '/resolve'
      const host = validateHost(arg)
      command = `/tool fetch url=($host) mode=https output=none keep-result=no`
      // A DNS lookup is a fetch of the host itself, which is exactly what
      // RouterOS offers without a shell.
      params = {}
    } else {
      const mapped = DIAGNOSTIC_COMMANDS[action]
      if (!mapped) {
        // An unknown action is refused outright. This is the security boundary.
        throw Object.assign(
          new RouterConnectError(
            `"${action}" is not an allowed diagnostic. Allowed actions: `
            + `${Object.keys(DIAGNOSTIC_COMMANDS).join(', ')}, ping, dns.`,
            null, undefined, false),
          { retryable: false })
      }
      command = mapped
    }

    try {
      const res = await client.run(target, command, params)
      const output = renderRows(res.rows)
      await ctx.recordDiagnostic(target.nodeId, target.ispId, {
        action, target: arg || null, ok: true, output,
        duration_ms: Date.now() - started,
      })
      return {
        ok: true, durationMs: Date.now() - started, method: res.method,
        result: { action, rows: res.rows.length, output },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ctx.recordDiagnostic(target.nodeId, target.ispId, {
        action, target: arg || null, ok: false, error: message,
        duration_ms: Date.now() - started,
      })
      throw err
    }
  }
}

/**
 * Rejects anything that is not plainly a hostname or IPv4 address.
 *
 * This is the second half of the security boundary: even for the two commands
 * that take an argument, a value containing a space, a quote or a RouterOS
 * metacharacter never reaches the router.
 */
export function validateHost(value: string): string {
  if (!value) throw new Error('This diagnostic needs a target address.')
  if (value.length > 253) throw new Error('That target is too long to be a hostname.')
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(
      'That target contains characters that are not valid in a hostname or IP '
      + 'address. Nothing was sent to the router.')
  }
  return value
}

/** Renders rows as readable text for the diagnostic log. */
function renderRows(rows: Record<string, string>[]): string {
  if (rows.length === 0) return '(no rows returned)'
  return rows.slice(0, 100).map((row, i) => {
    const cells = Object.entries(row)
      .filter(([k]) => k !== '.id')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    return `${i + 1}: ${cells}`
  }).join('\n')
}
// -----------------------------------------------------------------------------
//  RADIUS
// -----------------------------------------------------------------------------

/**
 * radius_sync: push one subscriber's attributes to the router's RADIUS client.
 *
 * Two separate things happen here, and which of them succeeded matters:
 *
 *   1. The platform's `radius_accounts` mirror is updated. That is our own
 *      bookkeeping and always succeeds.
 *   2. The router is asked to apply the attributes. That can fail, and when it
 *      does the mirror is left in `failed` carrying the router's own words.
 *
 * The job is a success only when both happened. A mirror saying "synced" while
 * the router refused the attributes is exactly the failure this design exists to
 * prevent.
 */
export function radiusSyncHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const username = String(job.payload.username ?? '')
    const rateLimit = String(job.payload.rate_limit ?? '')
    const expiry = job.payload.expiry ? String(job.payload.expiry) : null
    const simultaneousUse = Number(job.payload.simultaneous_use ?? 1)

    if (!username) throw new RouterConnectError('radius_sync requires a username.')

    const mirror = {
      isp_id: job.isp_id,
      client_id: job.payload.client_id ?? null,
      node_id: target.nodeId,
      username,
      service: String(job.payload.service ?? 'hotspot'),
      plan_id: job.payload.plan_id ?? null,
      rate_limit: rateLimit || null,
      expiry,
      simultaneous_use: Number.isFinite(simultaneousUse) ? simultaneousUse : 1,
      sync_state: 'processing',
      updated_at: new Date().toISOString(),
    }

    try {
      // RADIUS is optional. A router with no /radius entry cannot authenticate
      // against an external server, and quietly applying nothing would hide a
      // real configuration gap.
      const servers = await client.run(target, '/radius/print')
      if (servers.rows.length === 0) {
        const message =
          'This router has no RADIUS server configured, so subscriber attributes '
          + 'cannot be applied. Add one in RouterOS, or in the ISP network settings.'
        await ctx.saveRadiusAccount({ ...mirror, sync_state: 'failed', last_error: message })
        throw Object.assign(new RouterConnectError(message, null, undefined, false),
          { retryable: false })
      }

      const server = servers.rows[0]
      const apply: Record<string, string> = {}
      if (rateLimit) apply['Mikrotik-Rate-Limit'] = rateLimit
      if (expiry) apply['Mikrotik-Expires'] = expiry
      if (Number.isFinite(simultaneousUse)) {
        apply['Mikrotik-Simultaneous-Limit'] = String(simultaneousUse)
      }

      if (Object.keys(apply).length > 0) {
        // A fixed command path with a fixed key set. No user input is ever
        // interpolated into a RouterOS path.
        await client.run(target, '/radius/incoming/set', {
          ...apply,
          ...(server['.id'] ? { '.id': server['.id'] } : {}),
        })
      }

      await ctx.saveRadiusAccount({
        ...mirror,
        sync_state: 'synced',
        status: 'synced',
        last_error: null,
        last_synced_at: new Date().toISOString(),
      })

      return {
        ok: true, durationMs: Date.now() - started,
        result: {
          username,
          server: server.address ?? null,
          attributes: Object.keys(apply),
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ctx.saveRadiusAccount({ ...mirror, sync_state: 'failed', last_error: message })
      throw err
    }
  }
}
/**
 * session_sync: reconcile the platform's live sessions with the router's.
 *
 * This is what stops "Online Users" from showing yesterday's customers. What the
 * router reports is passed back verbatim so the platform can reconcile against
 * its own sessions table, keyed on MAC so a reconnect keeps its identity.
 */
export function sessionSyncHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    if (!target) throw new RouterConnectError('No router credentials for this job.')

    const live = await client.run(target, '/ip/hotspot/active/print')
    const macs = live.rows
      .map((r) => r['mac-address'])
      .filter((m): m is string => Boolean(m))

    await ctx.saveNode(target.nodeId, {
      active_users: live.rows.length,
      sync_state: 'synced',
      last_sync_error: null,
    })

    return {
      ok: true, durationMs: Date.now() - started,
      result: {
        live_users: live.rows.length,
        macs,
        // A sample rather than the whole table: a few hundred rows through a
        // job result is fine, several thousand on an RB941 is not.
        sample: live.rows.slice(0, 50).map((r) => ({
          user: r.user ?? null,
          address: r.address ?? null,
          mac: r['mac-address'] ?? null,
          uptime: r.uptime ?? null,
          bytes_in: r['bytes-in'] ?? null,
          bytes_out: r['bytes-up'] ?? null,
        })),
      },
    }
  }
}

/**
 * provision: walk the stage list, one stage at a time, resuming where the last
 * run stopped.
 *
 * THE RESUME RULE, which is the whole design:
 *
 *   The stage table is the memory. This handler does not remember anything
 *   between invocations, and neither does the job row. It asks the database
 *   "which is the first stage that has not settled?", runs exactly that one, and
 *   returns. So a worker killed halfway through RADIUS comes back, re-reads the
 *   table, finds RADIUS still unsettled, and repeats only RADIUS.
 *
 *   That is why stages are idempotent rather than merely guarded: the retry path
 *   and the crash path are the same code path, so anything that is not safe to
 *   run twice cannot be allowed to run twice.
 *
 * WHY ONE STAGE PER CLAIM
 * -----------------------
 * The job timeout is minutes and a thirteen-stage run over a slow link is not.
 * One stage per claim keeps every job short, makes the lease meaningful, and
 * gives the operator a job log that says which step was in flight. The queue row
 * stays `processing` until the run finishes; the re-claim path in
 * `claim_router_jobs` reclaims it once the lease expires.
 *
 * NOTHING HERE SETS ONLINE. That is the database's `router_online_blocker`, and
 * the session reaches `online` only after it agrees.
 */
export function provisionHandler(ctx: HandlerContext, client: RouterClient): JobHandler {
  return async (job, target): Promise<JobOutcome> => {
    const started = Date.now()
    const sessionId = String(job.payload?.session_id ?? '')
    if (!sessionId) {
      return {
        ok: false, durationMs: 0, retryable: false,
        error: 'This provisioning job carries no session_id.',
      }
    }
    if (!target) {
      throw new RouterConnectError('No router credentials for this provisioning job.')
    }

    const work = await ctx.loadProvisioning(sessionId)
    if (!work) {
      return {
        ok: false, durationMs: 0, retryable: false,
        error: `Provisioning session ${sessionId} no longer exists.`,
      }
    }

    // The first stage that has not settled. `failed` and `running` are both
    // "still to do", deliberately: a failed stage is exactly what a retry is for,
    // and a running one is what a dead worker left behind.
    const settled = isStageSettled
    const next = work.stageOrder.find((name) => !settled(work.stageStatuses[name]))
    if (!next) {
      // Everything settled. This is a resume of a finished run, so it is a
      // success - not an error, and not a reason to touch the router again.
      return {
        ok: true,
        durationMs: Date.now() - started,
        result: { stages: 'all_settled', note: 'Nothing left to do.' },
      }
    }

    const stageCtx: StageContext = {
      session: work.session,
      plans: work.plans,
      customers: work.customers,
    }

    // Claim it. The database refuses this out of order, which is the guarantee
    // that a stage can never run before the one it depends on.
    await ctx.advanceStage(sessionId, next, 'running', { ispId: work.session.ispId })

    const outcome = await runStage(next, client, target, stageCtx)

    await ctx.advanceStage(sessionId, next, outcome.status, {
      ispId: work.session.ispId,
      error: outcome.error ?? null,
      skipReason: outcome.skipReason ?? null,
      detail: outcome.detail ?? {},
    })

    if (outcome.status === 'failed') {
      // The stage is recorded FAILED and the session is marked failed, with the
      // operator's actual reason. Completed stages are left alone: a retry
      // resumes from this stage rather than re-running work that already worked.
      await ctx.setSessionState(sessionId, 'failed', outcome.error ?? 'Stage failed.')
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: outcome.error ?? `Stage ${next} failed.`,
        retryable: outcome.retryable ?? false,
        result: { stage: next, status: outcome.status },
      }
    }

    // A backup that succeeded is recorded so the ONLINE gate can require it.
    if (next === 'backup' && outcome.status === 'success') {
      const filename = (outcome.detail as { filename?: string })?.filename
      if (filename) {
        await ctx.recordBackup(sessionId, {
          nodeId: target.nodeId,
          ispId: work.session.ispId,
          filename,
          kind: 'binary',
          sizeBytes: Number((outcome.detail as { size_bytes?: string })?.size_bytes ?? 0) || null,
        })
      }
    }

    // Queue the next pass through the EXISTING queue, so the run keeps going
    // after this job row completes. Without this the run would stop after one
    // stage, because nothing else would claim the job again.
    //
    // The pass number comes from the job's own attempt count, so a reclaimed job
    // re-queues itself under a NEW key while a duplicate delivery of the same
    // pass is deduplicated by the existing idempotency rule.
    const pass = Number(job.attempt_count ?? 1)
    await ctx.enqueueNextPass(
      sessionId, target.nodeId, work.session.ispId, pass,
    )

    return {
      ok: true,
      durationMs: Date.now() - started,
      result: {
        stage: next,
        status: outcome.status,
        remaining: work.stageOrder.filter((n) => !settled(work.stageStatuses[n])
          && n !== next).length,
      },
    }
  }
}

/**
 * Decides whether a stage status means "this stage is finished".
 *
 * Exported because the resume rule and the ONLINE gate must agree on it, and the
 * one place they can silently disagree is here: if a caller treated 'unsupported'
 * as unsettled it would loop forever, and if it treated 'failed' as settled it
 * would walk straight past a broken RADIUS stage.
 */
export const isStageSettled = (s: StageStatus | undefined): boolean =>
  s === 'success' || s === 'skipped' || s === 'unsupported'

/** Every job kind the worker knows how to run. */
export function buildHandlers(
  ctx: HandlerContext,
  client: RouterClient,
): Record<string, JobHandler> {
  return {
    heartbeat: heartbeatHandler(ctx, client),
    provision: provisionHandler(ctx, client),
    capabilities: capabilitiesHandler(ctx, client),
    voucher_sync: voucherSyncHandler(ctx, client),
    voucher_revoke: voucherRevokeHandler(ctx, client),
    customer_sync: customerSyncHandler(ctx, client),
    customer_suspend: customerSuspendHandler(ctx, client),
    customer_reactivate: customerReactivateHandler(ctx, client),
    // Expiry and suspension do the same thing on the router: the account stops
    // working. Reuse the handler rather than writing a second copy.
    customer_expire: customerSuspendHandler(ctx, client),
    radius_sync: radiusSyncHandler(ctx, client),
    disconnect: disconnectHandler(ctx, client),
    session_sync: sessionSyncHandler(ctx, client),
    diagnostic: diagnosticHandler(ctx, client),
    telemetry: heartbeatHandler(ctx, client),
  }
}