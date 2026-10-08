/**
 * Client for the FastAPI provisioning engine (`backend/`).
 *
 * This replaces the old Supabase Edge Function client (`provisionAction` /
 * `startProvisioning`). The provision engine is a standalone FastAPI service:
 * it owns the bootstrap one-liner, device scan, provisioning sessions, the
 * workflow and the live WebSocket log stream.
 *
 * Auth: the engine's provisioning endpoints accept ANONYMOUS calls (the
 * operator runs the wizard with no sign-in step). If `VITE_API_EMAIL` /
 * `VITE_API_PASSWORD` are configured, a JWT is obtained silently and sent;
 * otherwise requests go out unauthenticated and the engine resolves them to
 * its synthetic provisioning user. See backend/docs/PROVISIONING_AUTH.md.
 */
import { config } from './config'

const TOKEN_KEY = 'ispflow.provision.token'
const USER_KEY = 'ispflow.provision.user'

/** An error the UI can explain; `detail` carries whatever the server sent. */
export class ProvisionError extends Error {
  detail?: Record<string, unknown>
  /** True when the failure is simply "not signed in to the engine yet". */
  needsSignIn?: boolean
}

let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
})()

export function hasAuthToken(): boolean {
  return Boolean(token)
}

export function clearAuthToken(): void {
  token = null
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    /* private mode / SSR - ignore */
  }
}

/** Sign in to the provisioning engine and cache the JWT. */
export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch(`${config.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    data?: { access_token?: string; user?: { username?: string; role?: string } }
    detail?: string
  }
  if (!res.ok || !body.data?.access_token) {
    const err = new ProvisionError(
      body.detail ?? `Sign-in failed (HTTP ${res.status}).`,
    ) as ProvisionError
    err.detail = body as Record<string, unknown>
    throw err
  }
  token = body.data.access_token
  try {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, JSON.stringify(body.data.user ?? {}))
  } catch {
    /* ignore storage failures - in-memory token still works */
  }
}

/**
 * Make sure we hold a JWT — but never gate the wizard on one.
 *
 * The engine's provisioning endpoints accept anonymous calls, so a missing
 * token is fine. When `VITE_API_EMAIL` / `VITE_API_PASSWORD` are configured
 * we still sign in silently (best effort: the token is then used for org
 * scoping and audit); if that fails we simply proceed without a token.
 */
async function ensureAuth(): Promise<void> {
  if (token) return
  if (config.apiEmail && config.apiPassword) {
    try {
      await signIn(config.apiEmail, config.apiPassword)
    } catch {
      // Silent sign-in failed (engine unreachable or creds wrong) — the
      // engine accepts anonymous provisioning calls, so continue without.
    }
  }
}

/**
 * Wrap a fetch failure (DNS/connection refused/CORS — browsers report all of
 * these as `TypeError: Failed to fetch`) into an actionable message: on the
 * public deployment the most common cause is the engine not running / not
 * reachable at `config.apiUrl`.
 */
function toNetworkError(e: unknown, path: string): ProvisionError {
  const err = new ProvisionError(
    `Cannot reach the provisioning engine at ${config.apiUrl} (${path}). ` +
    'The engine must be running and reachable from this browser — start it ' +
    'with `docker compose --profile backend up` (or `uvicorn` on this machine), ' +
    'and make sure VITE_API_URL points at it.',
  ) as ProvisionError
  err.detail = { reason: 'engine-unreachable', cause: e instanceof Error ? e.message : String(e) }
  return err
}

function extractDetail(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.detail === 'string') return b.detail
    if (b.detail && typeof b.detail === 'object') {
      const d = b.detail as Record<string, unknown>
      if (typeof d.message === 'string') return d.message
    }
    const e = b.error
    if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') {
      return (e as Record<string, string>).message
    }
    if (typeof e === 'string') return e
    if (typeof b.message === 'string') return b.message
  }
  return 'The provisioning engine rejected the request.'
}

/**Authenticated-when-possible fetch against the engine. Retries once after re-auth on 401. */
async function api<T>(
  path: string,
  init: RequestInit = {},
  allowReauth = true,
): Promise<T> {
  await ensureAuth()
  let res: Response
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token ?? ''}`,
        ...(init.body && !(init.body instanceof URLSearchParams)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (e) {
    // Network-level failure (engine down, wrong port, CORS) — surface an
    // actionable message instead of the browser's "Failed to fetch".
    throw toNetworkError(e, path)
  }

  if (res.status === 401 && allowReauth) {
    // Expired JWT: drop it and retry once with a fresh sign-in.
    clearAuthToken()
    await ensureAuth()
    return api<T>(path, init, false)
  }

  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const err = new ProvisionError(extractDetail(body)) as ProvisionError
    err.detail = (body ?? {}) as Record<string, unknown>
    if (res.status === 401) err.needsSignIn = true
    throw err
  }
  return body as T
}

// ───────────────────────────────────────────────────────────────────────────
// Engine response shapes
// ───────────────────────────────────────────────────────────────────────────

export type ProvisioningServiceType = 'hotspot' | 'pppoe_server' | 'both'

export interface BackendRouter {
  id: number
  name: string
  ip_address: string
  port: number
  status: string
  bootstrap_completed?: boolean
  provisioning_status?: string
}

export interface ProvisionSession {
  session_id: string
  router_id: number
  status: string
  service_type: string | null
  created_at: string | null
  completed_at: string | null
}

export interface BootstrapCommand {
  command: string
  script_url: string
  token: string
  expires_in: number
  notes: string[]
  notify_url: string
  bootstrap_already_done: boolean
  encrypted_url: boolean
  ping_check?: { reachable: boolean; latency_ms: number | null; method: string | null }
  warnings?: string[]
}

export interface ScanService {
  name: string
  active: boolean
  available: boolean
}

export interface NetworkConfig {
  router_ip: string
  router_ip_cidr: string
  network: string
  network_address: string
  gateway: string
  broadcast: string
  dhcp_start: string
  dhcp_end: string
  dhcp_pool: string
  subnet_mask: string
  cidr: number
  total_hosts: number
  dns_servers: string[]
  current_subnet: string
  wan_interface: string
}

export interface DeviceScan {
  interfaces: string[]
  wan_interface: string
  services: ScanService[]
  network_config: NetworkConfig
  system_info: {
    identity: string
    board_name: string
    model: string
    version: string
    architecture: string
    uptime: string | null
  }
  current_subnet: string
  available_services: string[]
}

export interface SessionStatus {
  session_id: string
  status: string
  current_step?: string | null
  progress?: number | null
  error_message?: string | null
}

/** One frame off the engine's WebSocket (`/api/v1/provisioning/ws/{id}`). */
export interface StreamMessage {
  type: 'log' | 'status' | 'scan_complete' | 'provisioning_complete'
    | 'router_log' | 'pong' | string
  session_id?: string
  data?: Record<string, unknown>
}

// ───────────────────────────────────────────────────────────────────────────
// Endpoints
// ───────────────────────────────────────────────────────────────────────────

/** Lists routers known to the engine (used to find an existing row by name). */
export async function findRouter(name: string): Promise<BackendRouter | null> {
  const body = await api<{ items?: BackendRouter[] }>(
    `/api/v1/routers/?search=${encodeURIComponent(name)}&size=50`,
  )
  return body.items?.find((r) => r.name === name) ?? null
}

/** Creates the router row; reuses an existing row with the same name. */
export async function upsertRouter(args: {
  name: string
  ip_address: string
  api_port: number
}): Promise<BackendRouter> {
  const existing = await findRouter(args.name)
  if (existing) return existing
  return api<BackendRouter>('/api/v1/routers/', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

/** Create-only session (POST /provisioning/sessions) - embeds into notify URL. */
export async function createSession(
  routerId: number,
  serviceType: ProvisioningServiceType,
  configuration: Record<string, unknown>,
): Promise<{ session_id: string; status: string }> {
  return api('/api/v1/provisioning/sessions', {
    method: 'POST',
    body: JSON.stringify({ router_id: routerId, service_type: serviceType, configuration }),
  })
}

/** The one-liner the operator pastes into the router terminal. */
export async function getBootstrapCommand(args: {
  identity: string
  api_port: number
  interface: string
  ip_address?: string
  session_id?: string
  router_id?: number
}): Promise<BootstrapCommand> {
  const qs = new URLSearchParams({
    identity: args.identity,
    api_port: String(args.api_port),
    interface: args.interface,
    ...(args.ip_address ? { ip_address: args.ip_address } : {}),
    ...(args.session_id ? { session_id: args.session_id } : {}),
    ...(args.router_id ? { router_id: String(args.router_id) } : {}),
  })
  return api(`/api/v1/provisioning/bootstrap/command?${qs}`)
}

/** Reads the device's interfaces / services / network config. */
export async function scanDevice(
  routerId: number,
  forceRescan = false,
): Promise<DeviceScan> {
  return api('/api/v1/provisioning/device/scan', {
    method: 'POST',
    body: JSON.stringify({ router_id: routerId, force_rescan: forceRescan }),
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Response of `GET /bootstrap/can-use-direct-api/{router_id}` (DB-only). */
export interface DirectApiStatus {
  can_use_direct_api: boolean
  bootstrap_completed: boolean
  provisioning_status: string
  last_provisioned_at: string | null
  agent_installed: boolean
  agent_online: boolean
  has_cached_scan: boolean
}

/**
 * Cheap probe: reads only the router row — it NEVER dials the device — so
 * the wizard can poll it as fast as it likes even when the router sits
 * behind NAT. `has_cached_scan` flips when the bootstrap script's
 * `POST /bootstrap/scan-report` has been stored; `bootstrap_completed`
 * flips when the script's final `POST /bootstrap/notify` lands.
 */
export async function getDirectApiStatus(routerId: number): Promise<DirectApiStatus> {
  return api(`/api/v1/provisioning/bootstrap/can-use-direct-api/${routerId}`)
}

/**
 * Waits for the router's phone-home scan report instead of hanging on a
 * single direct-dial scan.
 *
 * Behind NAT neither the browser nor the backend can dial the router, so a
 * one-shot `scanDevice(routerId, …)` burns the MikroTik connect timeout
 * (with retries) and looks stalled. The engine's intended flow is:
 * bootstrap script runs on the router → POSTs `/bootstrap/scan-report`
 * (cached on the router row + Redis) → `scanDevice(routerId, false)` serves
 * that cache instantly.
 *
 * Strategy: an optimistic `scanDevice(routerId, false)` races in the
 * background (it succeeds immediately on a LAN or when a report is already
 * cached; behind NAT it just fails harmlessly), while the main loop polls
 * the DB-only probe every `intervalMs` and reads the cache the moment the
 * report lands. On deadline it throws a `ProvisionError` with an
 * actionable message — it never triggers a direct dial itself.
 */
export async function waitForScanReport(
  routerId: number,
  opts: {
    /** Overall budget for the report to arrive (default 120s). */
    deadlineMs?: number
    /** Gap between probe polls (default 2s). */
    intervalMs?: number
    /** Minimum gap between onProgress calls (default 6s). */
    progressIntervalMs?: number
    /** Called with elapsed seconds while waiting, for progress UI. */
    onProgress?: (elapsedSeconds: number) => void
  } = {},
): Promise<DeviceScan> {
  const deadlineMs = opts.deadlineMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 2_000
  const progressIntervalMs = opts.progressIntervalMs ?? 6_000
  const started = Date.now()
  let lastDetail = ''
  let lastProgressAt = 0

  // Optimistic read: resolves instantly when the cache is warm or the router
  // is directly reachable (LAN). Behind NAT it rejects — swallowed here so
  // the probe loop below keeps waiting for the phone-home report.
  const eager = scanDevice(routerId, false).then(
    (s) => s,
    (e) => {
      lastDetail = e instanceof Error ? e.message : String(e)
      return null
    },
  )
  // A null (failed) eager result must not win the race — only a real scan.
  const eagerWin = eager.then((s) => (s ? s : new Promise<never>(() => {})))

  const probeLoop = (async (): Promise<DeviceScan> => {
    for (;;) {
      try {
        const st = await getDirectApiStatus(routerId)
        if (st.has_cached_scan || st.bootstrap_completed) {
          // force_rescan=false → the backend serves the cache; it only dials
          // when the cache is empty (stale flag), in which case we keep polling.
          try {
            return await scanDevice(routerId, false)
          } catch (e) {
            lastDetail = e instanceof Error ? e.message : String(e)
          }
        }
      } catch (e) {
        // Probe failure (backend restart etc.) — retry until the deadline.
        lastDetail = e instanceof Error ? e.message : String(e)
      }

      const elapsed = Date.now() - started
      if (elapsed >= deadlineMs) break
      if (elapsed - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = elapsed
        opts.onProgress?.(Math.round(elapsed / 1000))
      }
      await sleep(intervalMs)
    }

    const err = new ProvisionError(
      'No scan report from the router yet. Paste the bootstrap one-liner into ' +
        'the router terminal (Winbox: New Terminal), wait ~10 seconds for it ' +
        'to finish, then scan again — the wizard reads the report the router ' +
        'sends back, so it also works behind NAT.' +
        (lastDetail ? ` Last response: ${lastDetail}` : ''),
    ) as ProvisionError
    err.detail = { reason: 'scan-report-timeout', lastDetail }
    throw err
  })()

  return Promise.race([eagerWin, probeLoop])
}

/** Starts the background provisioning workflow (creates its own session). */
export async function startWorkflow(
  routerId: number,
  serviceType: ProvisioningServiceType,
  configuration: Record<string, unknown>,
): Promise<{ session_id: string; status: string; message: string }> {
  return api('/api/v1/provisioning/workflow', {
    method: 'POST',
    body: JSON.stringify({ router_id: routerId, service_type: serviceType, configuration }),
  })
}

export async function getSessionStatus(sessionId: string): Promise<SessionStatus> {
  return api(`/api/v1/provisioning/sessions/${sessionId}/status`)
}

export async function listSessions(): Promise<ProvisionSession[]> {
  const body = await api<{ sessions?: ProvisionSession[] }>(
    '/api/v1/provisioning/sessions?limit=20',
  )
  return body.sessions ?? []
}

/** Clears stale PENDING/IN_PROGRESS sessions so a new workflow can start. */
export async function cancelActiveSessions(
  routerId: number,
): Promise<{ cancelled_count: number }> {
  return api(`/api/v1/provisioning/router/${routerId}/cancel-active`, {
    method: 'POST',
  })
}

/**
 * Opens the engine's live log stream for a session. Returns the socket; the
 * caller closes it (or passes it to `closeStream`).
 */
export function openStream(
  sessionId: string,
  onMessage: (msg: StreamMessage) => void,
  onClose?: () => void,
): WebSocket {
  const wsUrl =
    config.apiUrl.replace(/^http/, 'ws') + `/api/v1/provisioning/ws/${sessionId}`
  const ws = new WebSocket(wsUrl)
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)) as StreamMessage)
    } catch {
      /* non-JSON frame - ignore */
    }
  }
  ws.onclose = () => onClose?.()
  return ws
}



