/**

 * Provisioning API client â€” clean, typed, and reliable.

 *

 * This replaces the legacy client with:

 * - Proper Supabase session handling (waits for initialization)

 * - Clear error types with actionable messages

 * - Typed request/response shapes matching backend contracts

 * - No localStorage token caching (uses Supabase session directly)

 * - Consistent error handling for all HTTP status codes

 */



import { config, IS_LIVE } from './config'

import { requireSupabase } from './supabase'



/** Error codes that the UI can act upon. */

export const ProvisionErrorCode = {

  NETWORK_ERROR: 'NETWORK_ERROR',

  ENGINE_UNREACHABLE: 'ENGINE_UNREACHABLE',

  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',

  SESSION_EXPIRED: 'SESSION_EXPIRED',

  FORBIDDEN: 'FORBIDDEN',

  NOT_FOUND: 'NOT_FOUND',

  VALIDATION_ERROR: 'VALIDATION_ERROR',

  SERVER_ERROR: 'SERVER_ERROR',

  NON_JSON_RESPONSE: 'NON_JSON_RESPONSE',

  UNKNOWN: 'UNKNOWN',

} as const



export type ProvisionErrorCode = typeof ProvisionErrorCode[keyof typeof ProvisionErrorCode]



/**

 * Structured error the UI can explain and act upon.

 * `code` allows programmatic handling; `detail` carries raw server payload.

 */

export class ProvisionError extends Error {

  public readonly code: ProvisionErrorCode

  public readonly status: number | null

  public readonly detail: Record<string, unknown> | null

  public readonly needsSignIn: boolean



  constructor(

    message: string,

    code: ProvisionErrorCode = ProvisionErrorCode.UNKNOWN,

    options: { status?: number | null; detail?: Record<string, unknown> | null; needsSignIn?: boolean } = {}

  ) {

    super(message)

    this.name = 'ProvisionError'

    this.code = code

    this.status = options.status ?? null

    this.detail = options.detail ?? null

    this.needsSignIn = options.needsSignIn ?? false

  }



  static fromResponse(

    path: string,

    status: number,

    body: unknown,

    contentType: string

  ): ProvisionError {

    void path

    const isHtml = contentType.includes('text/html')

    const isJson = contentType.includes('application/json')



    let message: string

    let code: ProvisionErrorCode

    let detail: Record<string, unknown> | null = null

    let needsSignIn = false



    // A non-JSON body is a routing/proxy problem, not an API answer. That is

    // checked FIRST â€” including for 5xx â€” so a Cloudflare or VPS proxy HTML

    // page is reported as a misconfigured rewrite rather than a generic server

    // error the operator cannot act on.

    if (!isJson) {

      code = ProvisionErrorCode.NON_JSON_RESPONSE

      message = status === 401

        ? 'The provisioning engine rejected the request with an HTML page instead of JSON. The API rewrite may be misconfigured.'

        : isHtml

          ? 'The provisioning engine returned an HTML page instead of JSON. (ct=, status=) The API rewrite may be misconfigured, or a proxy returned an error page.'

          : 'The provisioning engine returned a non-JSON response. (ct=, status=)'

      needsSignIn = status === 401

    } else if (status === 401) {

      code = ProvisionErrorCode.NOT_AUTHENTICATED

      message = 'Authentication required. Please sign in or continue as guest.'

      needsSignIn = false

    } else if (status === 403) {

      code = ProvisionErrorCode.FORBIDDEN

      message = 'You do not have permission to perform this action.'

    } else if (status === 404) {

      code = ProvisionErrorCode.NOT_FOUND

      message = 'The requested resource was not found.'

    } else if (status === 422) {

      code = ProvisionErrorCode.VALIDATION_ERROR

      message = isJson && body && typeof body === 'object' && 'detail' in body

        ? String((body as Record<string, unknown>).detail)

        : 'The request data is invalid.'

    } else if (status >= 500) {

      code = ProvisionErrorCode.SERVER_ERROR

      message = 'The provisioning engine returned an error. Please try again.'

    } else {

      code = ProvisionErrorCode.UNKNOWN

      message = 'An unexpected error occurred.'

    }



    if (body && typeof body === 'object') {

      detail = body as Record<string, unknown>

    }



    return new ProvisionError(message, code, { status, detail, needsSignIn })

  }



  static network(path: string, cause: unknown): ProvisionError {

    const target = config.apiUrl || 'the VPS API'

    return new ProvisionError(

      `Cannot reach the provisioning engine at ${target} (${path}). ` +

      'Check that the VPS API is running with a valid HTTPS certificate, ' +

      'the Vercel API rewrite targets its public hostname, and direct API ' +

      'calls use an origin allowed by the VPS CORS policy.',

      ProvisionErrorCode.ENGINE_UNREACHABLE,

      { detail: { reason: 'engine-unreachable', cause: cause instanceof Error ? cause.message : String(cause) } }

    )

  }

}



/** Build a URL against the VPS engine or Vercel's same-origin API rewrite. */

function apiUrl(path: string): string {

  const base = config.apiUrl

  if (IS_LIVE && import.meta.env.PROD && base) {

    let target: URL

    try {

      target = new URL(base)

    } catch {

      throw new ProvisionError(

        'VITE_API_URL must be an absolute HTTPS URL for the VPS provisioning API.',

        ProvisionErrorCode.UNKNOWN

      )

    }

    if (target.protocol !== 'https:' || target.hostname === 'localhost' || target.hostname === '127.0.0.1') {

      throw new ProvisionError(

        'VITE_API_URL must use the VPS public HTTPS hostname; localhost and plain HTTP are not supported in production.',

        ProvisionErrorCode.UNKNOWN

      )

    }

    if (target.origin === location.origin) {

      throw new ProvisionError(

        'VITE_API_URL must point to the VPS API, not the Vercel frontend origin.',

        ProvisionErrorCode.UNKNOWN

      )

    }

  }

  return base ? `${base}${path}` : path

}



/**

 * Get the current Supabase access token, waiting for session initialization.

 * This is the single source of truth for authentication tokens.

 */

async function getAccessToken(): Promise<string | null> {

  if (!IS_LIVE) {

    throw new ProvisionError(

      'Provisioning requires a live Supabase configuration.',

      ProvisionErrorCode.NOT_AUTHENTICATED,

      { needsSignIn: false }

    )

  }



  const sb = requireSupabase()



  // First, try to get the existing session (fast path)

  let { data: _data, error } = await sb.auth.getSession()

  if (error) { return null; }






  }




/** Make an authenticated request to the provisioning API. */
async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {

  const sb = requireSupabase()



  async function doFetch(token: string): Promise<Response> {

    return fetch(apiUrl(path), {

      ...init,

      headers: {

        'Authorization': `Bearer ${token}`, 

        ...(init.body && !(init.body instanceof URLSearchParams)

          ? { 'Content-Type': 'application/json' }

          : {}),

        ...(init.headers ?? {}),

      },

    })

  }



  let res: Response

  try {

    const token = await getAccessToken()

    res = await doFetch(token)

  } catch (e) {

    if (e instanceof ProvisionError) throw e

    throw ProvisionError.network(path, e)

  }



  if (res.status === 401) {

    try {

      const { data: refreshData, error: refreshError } = await sb.auth.refreshSession()

      if (!refreshError && refreshData.session?.access_token) {

        res = await doFetch(refreshData.session.access_token)

      }

    } catch {

      // ignore

    }

  }

  const contentType = res.headers.get('content-type') ?? ''

  const isJson = contentType.includes('application/json')



  // An API endpoint must always answer JSON. A text/html body means the

  // request was rewritten to the SPA (index.html), a proxy served an error

  // page, or the API origin is wrong. Treating that as a valid response is

  // exactly how production reported "no sessions" for a live tenant, so it is

  // rejected on BOTH the success and error paths.

  if (!isJson) {

    const text = await res.text().catch(() => null)

    const preview = typeof text === 'string' && text

      ? text.slice(0, 160).replace(/\s+/g, ' ')

      : ''

    throw new ProvisionError(

      contentType.includes('text/html')

        ? `The provisioning engine at ${path} returned an HTML page instead of JSON. (ct=, status=) The API rewrite may be misconfigured.`

        : `The provisioning engine at ${path} returned a non-JSON response. (ct=, status=)`,

      ProvisionErrorCode.NON_JSON_RESPONSE,

      {

        status: res.status,

        detail: {

          status: res.status,

          reason: 'non-json-response',

          contentType,

          ...(preview ? { preview } : {}),

        },

      },

    )

  }



  const body = await res.json().catch(() => null)



  if (!res.ok) {
    try { console.error('[provisionApi] error response', { path, status: res.status, contentType, body }) } catch {}
    throw ProvisionError.fromResponse(path, res.status, body, contentType)
  }



  if (body === null) {

    throw new ProvisionError(

      `The provisioning API returned an empty success response for ${path}.`,

      ProvisionErrorCode.NON_JSON_RESPONSE,

      { status: res.status }

    )

  }



  return body as T

}



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Engine response shapes (matching backend contracts)

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€



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



export interface StreamMessage {

  type: 'log' | 'status' | 'scan_complete' | 'provisioning_complete'

    | 'router_log' | 'pong' | string

  session_id?: string

  data?: Record<string, unknown>

}



export interface DirectApiStatus {

  can_use_direct_api: boolean

  bootstrap_completed: boolean

  provisioning_status: string

  last_provisioned_at: string | null

  agent_installed: boolean

  agent_online: boolean

  has_cached_scan: boolean

}



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Token management (for test compatibility)

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€



/** Check if we have a cached token (always false now â€” we use Supabase session). */

export function hasAuthToken(): boolean {

  return false

}



/** Clear any cached token (no-op â€” we use Supabase session). */

export function clearAuthToken(): void {

  // No-op: we don't cache tokens locally

}



/** Sign in to the provisioning engine (no-op â€” we use Supabase auth). */

export async function signIn(_email: string, _password: string): Promise<void> {

  // No-op: authentication is handled by Supabase

  // This exists for test compatibility

  if (!IS_LIVE) {

    throw new ProvisionError(

      'Provisioning requires a live Supabase configuration.',

      ProvisionErrorCode.NOT_AUTHENTICATED,

      { needsSignIn: false }

    )

  }

  const sb = requireSupabase()

  const { error } = await sb.auth.getSession()

  }


// Endpoints

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€



export async function findRouter(name: string): Promise<any> {
  const body = await api<{ items?: BackendRouter[] }>(
  export async function findRouter(name: string): Promise<any> {
    const body = await api<{ items?: BackendRouter[] }>(/api/v1/routers/?search=&size=50);
    return body.items?.find((r: any) => r.name === name) ?? null;
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

  forceRescan = false

): Promise<DeviceScan> {

  return api('/api/v1/provisioning/device/scan', {

    method: 'POST',

    body: JSON.stringify({ router_id: routerId, force_rescan: forceRescan }),

  })

}



const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))



export async function getDirectApiStatus(routerId: number): Promise<DirectApiStatus> {

  return api(`/api/v1/provisioning/bootstrap/can-use-direct-api/${routerId}`)

}



/**

 * Waits for the router's phone-home scan report instead of hanging on a

 * single direct-dial scan.

 */

export async function waitForScanReport(

  routerId: number,

  opts: {

    deadlineMs?: number

    intervalMs?: number

    progressIntervalMs?: number

    onProgress?: (elapsedSeconds: number) => void

  } = {}

): Promise<DeviceScan> {

  const deadlineMs = opts.deadlineMs ?? 120_000

  const intervalMs = opts.intervalMs ?? 2_000

  const progressIntervalMs = opts.progressIntervalMs ?? 6_000

  const started = Date.now()

  let lastDetail = ''

  let lastProgressAt = 0



  // Optimistic read: resolves instantly when cache is warm or router is directly reachable

  const eager = scanDevice(routerId, false).then(

    (s) => s,

    (e) => {

      lastDetail = e instanceof Error ? e.message : String(e)

      return null as DeviceScan | null

    }

  )

  const eagerWin = eager.then((s) => (s ? s : new Promise<never>(() => {})))



  const probeLoop = (async (): Promise<DeviceScan> => {

    for (;;) {

      try {

        const st = await getDirectApiStatus(routerId)

        if (st.has_cached_scan || st.bootstrap_completed) {

          try {

            return await scanDevice(routerId, false)

          } catch (e) {

            lastDetail = e instanceof Error ? e.message : String(e)

          }

        }

      } catch (e) {

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

        'to finish, then scan again â€” the wizard reads the report the router ' +

        'sends back, so it also works behind NAT.' +

        (lastDetail ? ` Last response: ${lastDetail}` : ''),

      ProvisionErrorCode.SERVER_ERROR,

      { detail: { reason: 'scan-report-timeout', lastDetail } }

    )

    throw err

  })()



  return Promise.race([eagerWin, probeLoop])

}




export const getBootstrapCommand = Rj;
export const createSession = Dj;
export const findRouter = zj;
export const createRouter = Oj;

export const listSessions = Uj;
export const getBootstrapCommand = Rj;
export const createSession = Dj;
export const findRouter = zj;
export const createRouter = Oj;
export const getProvisioningSessions = Uj;
export const generateBootstrapCommand = Rj;
