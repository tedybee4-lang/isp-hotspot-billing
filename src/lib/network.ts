/**
 * Network control plane access for the panel.
 *
 * Split out of data.ts because it is a distinct concern: everything here reads
 * from the RPCs added in 20260101000900_network_control_plane.sql, and the
 * important property of all of them is that the liveness decision is computed
 * in Postgres from a heartbeat threshold rather than taken from a status string.
 *
 * That separation matters for correctness, not just tidiness. If the panel
 * decided "online" itself it would be one implementation away from showing a
 * dead router as healthy.
 */
import { requireSupabase } from './supabase'
import { IS_LIVE } from './config'

export class NetworkError extends Error {}

export interface RouterSummary {
  id: string
  name: string
  host: string | null
  enabled: boolean
  status: string
  model: string | null
  board_name: string | null
  routeros_version: string | null
  routeros_major: number | null
  architecture: string | null
  is_chr: boolean
  mgmt_mode: string | null
  last_connection_method: string | null
  reachability: string
  reachability_note: string | null
  active_users: number
  cpu_load: number | null
  ram_used_mb: number | null
  ram_total_mb: number | null
  uptime_seconds: number | null
  last_heartbeat_at: string | null
  last_success_at: string | null
  last_failure_at: string | null
  consecutive_failures: number
  last_error: string | null
  provisioning_state: string
  sync_state: string
  /** Computed in Postgres from the heartbeat threshold, not from `status`. */
  online: boolean
}

export interface NetworkTotals {
  total: number
  online: number
  degraded: number
  provisioning: number
  offline: number
  behind_nat: number
  cgnat: number
  vpn_connected: number
  active_users: number
  cpu_avg: number | null
  ram_used_mb: number
  ram_total_mb: number
}

export interface LiveUserCounts {
  hotspot: number
  pppoe: number
  total: number
}

export interface QueueOverview {
  pending: number
  processing: number
  succeeded: number
  failed: number
  dead: number
  oldest_pending_at: string | null
}

export interface WorkerRow {
  name: string
  status: string
  hostname: string | null
  public_ip: string | null
  region: string | null
  version: string | null
  wg_address: string | null
  last_heartbeat_at: string | null
  jobs_processed: number
  jobs_failed: number
  last_error: string | null
  /** Computed: no beat in 90 seconds means the worker is gone. */
  alive: boolean
}

export interface RouterCapability {
  node_id: string
  detected_at: string
  detected_by: string
  board_name: string | null
  model: string | null
  routeros_version: string | null
  architecture: string | null
  is_chr: boolean
  license_level: string | null
  cpu_type: string | null
  cpu_count: number | null
  ram_total_mb: number | null
  storage_total_mb: number | null
  rest_available: boolean
  api_available: boolean
  api_ssl_available: boolean
  ssh_available: boolean
  has_hotspot: boolean
  has_pppoe: boolean
  has_wireguard: boolean
  has_bridge: boolean
  has_vlan: boolean
  has_dhcp: boolean
  has_queue_simple: boolean
  has_queue_tree: boolean
  has_radius: boolean
  has_scheduler: boolean
  has_scripting: boolean
  unsupported: string[]
  diagnostics: Record<string, unknown>
}

const emptyTotals: NetworkTotals = {
  total: 0, online: 0, degraded: 0, provisioning: 0, offline: 0,
  behind_nat: 0, cgnat: 0, vpn_connected: 0, active_users: 0,
  cpu_avg: null, ram_used_mb: 0, ram_total_mb: 0,
}

const emptyQueue: QueueOverview = {
  pending: 0, processing: 0, succeeded: 0, failed: 0, dead: 0, oldest_pending_at: null,
}

/**
 * Routers with their liveness, reachability and telemetry.
 *
 * In demo mode there is no backend, so the shape is returned empty rather than
 * invented. An empty dashboard that says "no data" is honest; a populated one
 * with made-up routers is not.
 */
export async function fetchNetworkOverview(): Promise<{
  routers: RouterSummary[]
  totals: NetworkTotals
  users: LiveUserCounts
}> {
  if (!IS_LIVE) return { routers: [], totals: emptyTotals, users: { hotspot: 0, pppoe: 0, total: 0 } }
  const sb = requireSupabase()
  const [routers, totals, users] = await Promise.all([
    sb.rpc('routers_summary'),
    sb.rpc('network_totals'),
    sb.rpc('live_users_total'),
  ])
  if (routers.error) throw new NetworkError(routers.error.message)
  if (totals.error) throw new NetworkError(totals.error.message)
  if (users.error) throw new NetworkError(users.error.message)
  return {
    routers: (routers.data ?? []) as RouterSummary[],
    totals: (totals.data ?? emptyTotals) as NetworkTotals,
    users: (users.data ?? { hotspot: 0, pppoe: 0, total: 0 }) as LiveUserCounts,
  }
}

/** What the job queue holds, so a stalled queue is visible rather than implied. */
export async function fetchQueueOverview(): Promise<QueueOverview> {
  if (!IS_LIVE) return emptyQueue
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('queue_overview')
  if (error) throw new NetworkError(error.message)
  return (data ?? emptyQueue) as QueueOverview
}

/** The workers, and whether each is actually beating. */
export async function fetchWorkerOverview(): Promise<WorkerRow[]> {
  if (!IS_LIVE) return []
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('worker_overview')
  if (error) throw new NetworkError(error.message)
  return (data ?? []) as WorkerRow[]
}

/** The last capability survey for a router, or null when it has never run. */
export async function fetchRouterCapabilities(
  nodeId: string,
): Promise<RouterCapability | null> {
  if (!IS_LIVE) return null
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('router_capabilities')
    .select('*')
    .eq('node_id', nodeId)
    .maybeSingle()
  if (error) throw new NetworkError(error.message)
  return (data as RouterCapability | null) ?? null
}
/**
 * Asks the worker to collect a heartbeat now.
 *
 * Queues a job rather than reaching for the router from the browser, which is
 * the whole point: a browser has no route to a router behind CGNAT, and a call
 * made from here would only ever appear to succeed.
 *
 * The idempotency key is bucketed by the minute, so a double-click reuses the
 * queued job instead of creating a second poll against the same device.
 */
export async function requestRouterHeartbeat(
  nodeId: string,
): Promise<{ jobId: string | null }> {
  if (!IS_LIVE) return { jobId: null }
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('enqueue_router_job', {
    p_node_id: nodeId,
    p_kind: 'heartbeat',
    p_payload: { source: 'panel' },
    p_idempotency_key: `panel-heartbeat:${nodeId}:${Math.floor(Date.now() / 60000)}`,
    p_priority: 5,
    p_max_attempts: 3,
  })
  if (error) throw new NetworkError(error.message)
  const r = data as { ok: boolean; job_id?: string; error?: string }
  if (!r?.ok) throw new NetworkError(r?.error ?? 'Could not queue a heartbeat.')
  return { jobId: r.job_id ?? null }
}

/** The diagnostics the worker will run. Fixed here and there; never free text. */
export const DIAGNOSTIC_ACTIONS = [
  { value: 'identity', label: 'System identity' },
  { value: 'resource', label: 'CPU / RAM / uptime' },
  { value: 'interface', label: 'Interfaces' },
  { value: 'route', label: 'Routing table' },
  { value: 'bridge', label: 'Bridges' },
  { value: 'hotspot_active', label: 'HotSpot active users' },
  { value: 'pppoe_active', label: 'PPPoE active clients' },
  { value: 'dhcp', label: 'DHCP servers' },
  { value: 'radius', label: 'RADIUS servers' },
  { value: 'queues', label: 'Simple queues' },
  { value: 'services', label: 'Enabled services' },
  { value: 'dns', label: 'DNS resolvers' },
  { value: 'ntp', label: 'NTP clients' },
  { value: 'connections', label: 'Firewall connections' },
  { value: 'log', label: 'Router log' },
] as const

/** The diagnostics that take an argument, with the label for that argument. */
export const TARGETED_DIAGNOSTICS = [
  { value: 'ping', label: 'Ping a host', targetLabel: 'Host or IP' },
  { value: 'dns_lookup', label: 'Resolve a hostname', targetLabel: 'Hostname' },
] as const
/**
 * Runs one allow-listed read-only diagnostic and waits for the result.
 *
 * The action name is fixed by the worker's table. There is no code path from
 * this call to an arbitrary RouterOS command - the worker refuses any action it
 * does not recognise, which is asserted by test.
 *
 * If the router never answers, this says so. It does not return an empty result
 * dressed up as a successful check.
 */
export async function runRouterDiagnostic(
  nodeId: string,
  action: string,
  target?: string,
): Promise<{ ok: boolean; output: string; error: string | null }> {
  if (!IS_LIVE) {
    return {
      ok: false,
      output: '',
      error: 'Diagnostics run against a real router through the network worker. '
        + 'Configure Supabase to use them.',
    }
  }
  const sb = requireSupabase()
  const before = Date.now()
  const { error: enqueueError } = await sb.rpc('enqueue_router_job', {
    p_node_id: nodeId,
    p_kind: 'diagnostic',
    p_payload: { action, target: target ?? null },
    p_priority: 1,
    p_max_attempts: 1,
  })
  if (enqueueError) throw new NetworkError(enqueueError.message)

  // Poll for the result row rather than assuming one exists. A router that is
  // offline will never produce one, and this returns honestly rather than
  // hanging forever or inventing output.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const { data } = await sb
      .from('network_diagnostics')
      .select('ok, output, error, created_at')
      .eq('node_id', nodeId)
      .eq('action', action)
      .order('created_at', { ascending: false })
      .limit(1)
    const row = (data ?? [])[0] as {
      ok: boolean; output: string | null; error: string | null; created_at: string
    } | undefined
    // Only accept a row written after this request, so an earlier result is
    // never presented as the answer to the one just asked.
    if (row && new Date(row.created_at).getTime() >= before - 1000) {
      return { ok: row.ok, output: row.output ?? '', error: row.error ?? null }
    }
  }
  return {
    ok: false,
    output: '',
    error: 'The router did not answer within 30 seconds. It may be offline, or the '
      + 'network worker may be down - check the worker card below.',
  }
}

/** Queues a retry for one dead or failed job. */
export async function retryRouterJob(jobId: string): Promise<void> {
  if (!IS_LIVE) return
  const sb = requireSupabase()
  const { error } = await sb
    .from('router_jobs')
    .update({ status: 'pending', next_run_at: new Date().toISOString(), error: null })
    .eq('id', jobId)
  if (error) throw new NetworkError(error.message)
}
/**
 * Starts a disconnect and waits for the router to confirm, or says it did not.
 *
 * This is the difference between a real disconnect and a database edit. The
 * router is asked to remove the session; only its answer moves the status to
 * `confirmed`. If no answer arrives the caller is told the request is
 * outstanding, because telling an ISP a customer was cut off when the router
 * never received the request is worse than saying nothing at all.
 */
export async function disconnectLiveSession(
  acctSessionId: string,
): Promise<{ confirmed: boolean; status: string; detail: string }> {
  if (!IS_LIVE) {
    throw new NetworkError(
      'Disconnecting a session needs the network worker. Configure Supabase first.')
  }
  const sb = requireSupabase()

  // Everything security-relevant happens server-side in
  // request_session_disconnect(): it resolves the ISP from the caller's own
  // session, refuses a session belonging to another tenant, refuses one that is
  // already closed, resolves the router itself through radius_nas, and only then
  // enqueues the worker's disconnect job.
  //
  // The browser therefore supplies exactly one value - the RADIUS session id it
  // was shown - and cannot name an isp_id, a node_id or a router. None of that
  // is re-implemented here, because re-implementing it in the client is how it
  // drifts out of step with the rules the database actually enforces.
  const { data, error } = await sb.rpc('request_session_disconnect', {
    p_acct_session_id: acctSessionId,
  })
  if (error) throw new NetworkError(error.message)

  const result = (data ?? {}) as {
    ok?: boolean
    already_closed?: boolean
    command_id?: string | null
    router_notified?: boolean
    detail?: string
  }

  // Already closed: idempotent, and not an error. A repeated disconnect must
  // never queue a second job or tell the customer they were cut off twice.
  if (result.already_closed) {
    return {
      confirmed: false,
      status: 'already_closed',
      detail: 'That session had already ended.',
    }
  }

  // The database is closed either way. Whether the ROUTER has been told is a
  // separate fact and the UI must never conflate the two.
  if (result.router_notified !== true || !result.command_id) {
    return {
      confirmed: false,
      status: 'closed_without_router',
      detail: result.detail
        ?? 'Closed in the system, but no router is attached to this session, '
        + 'so nothing was queued.',
    }
  }

  // Poll the command row the worker completes, so the panel shows the real
  // outcome rather than assuming success at queue time.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const { data: cmd } = await sb
      .from('router_session_commands')
      .select('status, error')
      .eq('id', result.command_id)
      .maybeSingle()
    const row = cmd as { status: string; error: string | null } | null
    if (row && row.status !== 'pending') {
      return {
        confirmed: row.status === 'confirmed',
        status: row.status,
        detail: row.error ?? '',
      }
    }
  }

  return {
    confirmed: false,
    status: 'unconfirmed',
    detail: 'DISCONNECT REQUESTED — ROUTER CONFIRMATION UNAVAILABLE. The router '
      + 'did not answer, so this cannot be reported as done.',
  }
}

/** Recent jobs for one router, so a failure can be read rather than guessed at. */
export async function fetchRouterJobs(
  nodeId: string,
  limit = 15,
): Promise<Array<{
  id: string
  kind: string
  status: string
  attempt_count: number
  error: string | null
  created_at: string
  completed_at: string | null
}>> {
  if (!IS_LIVE) return []
  const sb = requireSupabase()
  const { data, error } = await sb
    .from('router_jobs')
    .select('id, kind, status, attempt_count, error, created_at, completed_at')
    .eq('node_id', nodeId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new NetworkError(error.message)
  return (data ?? []) as never
}
