// =============================================================================
//  Router connection layer
//
//  One place that answers two questions:
//
//    1. How can we reach this router at all?
//    2. Which transport should we use?
//
//  Why this exists
//  ---------------
//  The previous client spoke HTTP REST and nothing else. That is wrong for a
//  large part of the installed base:
//
//    * REST was added in RouterOS 7.1. An RB941-2nD running 6.49 has no REST
//      service, so the only working transport is the binary API on 8728.
//    * REST is plain HTTP on 8080 by default, so the router password crosses
//      the network in the clear. The API over TLS does not.
//    * "Connected" used to mean "a row exists in the database", which is why a
//      dead router could still look healthy.
//
//  Every method is probed before it is believed. Nothing is reported as
//  supported until a real command has come back over it.
//
//  Transports, in the order they are preferred:
//
//      api_ssl  TLS on 8729  - the API, encrypted. Works from 6.49 up.
//      rest     HTTPS on 8080- stateless, cheap; 7.1+ only.
//      api      8728         - unencrypted. Last resort on an old router.
//      ssh      22           - for what the API cannot express.
//
//  Ordering rationale: prefer what is encrypted, prefer what is cheapest, and
//  never fall back silently - the method actually used is always recorded, so
//  the panel can warn when a router is being managed over plain HTTP.
//
//  The session core is shared with the VPS worker (worker/src/session.ts). Only
//  the socket differs: here it is a WebSocket, because a serverless runtime
//  cannot open raw TCP.
// =============================================================================

import {
  RouterConnectError, RouterOsApi, DEFAULT_TIMEOUT,
  isAuthFailure, isAlreadyExists,
  type ConnectionMethod, type WireChannel,
} from './session.ts'

export {
  RouterConnectError, RouterOsApi, isAuthFailure, isAlreadyExists,
  type ConnectionMethod, type WireChannel,
}

export interface RouterEndpoint {
  /** Hostname or IP. May be a WireGuard address like 10.77.0.2. */
  host: string
  restPort?: number
  apiPort?: number
  apiSslPort?: number
  sshPort?: number
  /**
   * `https` for REST by default. Plain `http` is allowed but is only chosen when
   * api_ssl and api have both failed, because it exposes the password.
   */
  restScheme?: 'http' | 'https'
  username: string
  password: string
  timeoutMs?: number
}

// -----------------------------------------------------------------------------
//  Minimal byte transport
//
//  WebSocket is the one bidirectional byte channel a serverless runtime can open
//  to a router. RouterOS serves the API over WebSocket on the same port as the
//  raw API, so the wire protocol is identical either way. The worker does not
//  use this: it has real sockets, and holds them open.
// -----------------------------------------------------------------------------

export type ChannelFactory = (
  endpoint: RouterEndpoint,
  method: ConnectionMethod,
  timeoutMs: number,
) => Promise<WireChannel>

/** Opens a WebSocket to the RouterOS API port. Works where TCP does not. */
export const websocketChannel: ChannelFactory = (endpoint, method, timeoutMs) =>
  new Promise((resolve, reject) => {
    const port = method === 'api_ssl'
      ? (endpoint.apiSslPort ?? 8729)
      : (endpoint.apiPort ?? 8728)
    const url = `wss://${endpoint.host}:${port}/`
    let settled = false

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.close() } catch { /* already closing */ }
      reject(new RouterConnectError(
        `${endpoint.host}:${port} did not complete the API handshake in ${timeoutMs}ms`,
        method, undefined, true))
    }, timeoutMs)

    socket.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        send: (bytes) => socket.send(bytes),
        close: () => { try { socket.close() } catch { /* already closing */ } },
      })
    }
    socket.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new RouterConnectError(
        `${endpoint.host}:${port} refused or could not negotiate the API socket. `
        + 'Check that the api or api-ssl service is enabled and reachable.',
        method, undefined, true))
    }
  })
// -----------------------------------------------------------------------------
//  REST client
//
//  Kept because it is the only transport a browser can speak directly, and
//  because it is the cheapest on a RouterOS 7 box. Everything else about REST
//  being "the" client is what this module is replacing.
// -----------------------------------------------------------------------------

const restBasicAuth = (user: string, pass: string): string =>
  'Basic ' + btoa(`${user}:${pass}`)

/** One REST command. Returns the rows RouterOS returned, parsed into objects. */
export async function restCommand(
  endpoint: RouterEndpoint,
  command: string,
  params: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<Record<string, string>[]> {
  const scheme = endpoint.restScheme ?? 'https'
  const url = `${scheme}://${endpoint.host}:${endpoint.restPort ?? 8080}/rest/${command}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: restBasicAuth(endpoint.username, endpoint.password),
        'Content-Type': 'text/plain',
      },
      body: Object.entries(params).map(([k, v]) => `${k}=${v}`).join('\n'),
      signal: ac.signal,
    })
  } catch (err) {
    throw new RouterConnectError(
      (err as Error).name === 'AbortError'
        ? `${command} timed out after ${timeoutMs}ms`
        : `Cannot reach ${endpoint.host}: ${(err as Error).message}`,
      'rest', undefined, true)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new RouterConnectError(
        `${command} was rejected: the username or password is wrong.`,
        'rest', res.status, false)
    }
    if (res.status === 404) {
      throw new RouterConnectError(
        `${command} returned 404: the REST service is disabled on this router. `
        + 'REST exists only on RouterOS 7.1 and later.',
        'rest', res.status, false)
    }
    throw new RouterConnectError(`${command} failed: HTTP ${res.status}`, 'rest', res.status)
  }

  const text = (await res.text()).trim()
  if (!text) return []
  return text.split('\n').filter(Boolean).map((line) => {
    const row: Record<string, string> = {}
    for (const pair of line.split('=')) {
      const eq = pair.indexOf('=')
      if (eq > 0) row[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    return row
  })
}
// -----------------------------------------------------------------------------
//  Capability probe
// -----------------------------------------------------------------------------

export type ProbedMethod = ConnectionMethod | 'unavailable'

export interface MethodProbe {
  method: ProbedMethod
  available: boolean
  /** How long the probe took, for the diagnostics screen. */
  latencyMs: number | null
  error: string | null
}

export interface TransportProbe {
  /** The method the platform will actually use, or `unavailable`. */
  selected: ProbedMethod
  methods: MethodProbe[]
  /**
   * True when nothing answered. This is the difference between "the router is
   * misconfigured" and "the router is unreachable", which the panel must not
   * conflate.
   */
  fullyUnreachable: boolean
  /**
   * True when nothing answered and the reason was credentials. Retrying will
   * not help, so the UI should say AUTH FAILED rather than OFFLINE.
   */
  authFailed: boolean
}

/**
 * Probes every transport and picks one.
 *
 * The order matters and is deliberate:
 *
 *   1. `api_ssl` first. It works on RouterOS 6.49 and up, it is encrypted, and
 *      on a pre-7.1 box it is the only encrypted option that exists.
 *   2. `rest` second. It is stateless and cheap, and over HTTPS it is safe.
 *      A 404 simply records REST as unavailable rather than as a fault.
 *   3. `api` last. It works on everything including the RB941-2nD, but it is
 *      unencrypted, so it is only chosen when nothing else worked - and the
 *      result is recorded so the panel can warn about it.
 */
/** Opens a session over a WebSocket channel and logs in. */
async function openSession(
  endpoint: RouterEndpoint,
  method: Exclude<ConnectionMethod, 'rest' | 'unavailable'>,
  factory: ChannelFactory,
  timeoutMs: number,
): Promise<RouterOsApi> {
  const channel = await factory(endpoint, method, timeoutMs)
  return RouterOsApi.open(channel, endpoint.username, endpoint.password, { timeoutMs })
}

/**
 * Probes every transport and picks one.
 *
 * The order matters and is deliberate:
 *
 *   1. `api_ssl` first. It works on RouterOS 6.49 and up, it is encrypted, and
 *      on a pre-7.1 box it is the only encrypted option that exists.
 *   2. `rest` second. It is stateless and cheap, and over HTTPS it is safe.
 *      A 404 simply records REST as unavailable rather than as a fault.
 *   3. `api` last. It works on everything including the RB941-2nD, but it is
 *      unencrypted, so it is only chosen when nothing else worked - and the
 *      result is recorded so the panel can warn about it.
 */
export async function probeMethods(
  endpoint: RouterEndpoint,
  factory: ChannelFactory = websocketChannel,
): Promise<TransportProbe> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT
  const methods: MethodProbe[] = []

  const attempt = async (method: ProbedMethod, run: () => Promise<unknown>) => {
    const started = Date.now()
    try {
      await run()
      methods.push({ method, available: true, latencyMs: Date.now() - started, error: null })
      return true
    } catch (err) {
      methods.push({
        method,
        available: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  const sslOk = await attempt('api_ssl', async () => {
    const api = await openSession(endpoint, 'api_ssl', factory, timeoutMs)
    try { await api.execute('/system/identity/print') } finally { api.close() }
  })

  const restOk = await attempt('rest', async () => {
    await restCommand(endpoint, '/system/identity/print', {}, timeoutMs)
  })

  const apiOk = await attempt('api', async () => {
    const api = await openSession(endpoint, 'api', factory, timeoutMs)
    try { await api.execute('/system/identity/print') } finally { api.close() }
  })

  const selected: ProbedMethod =
    sslOk ? 'api_ssl' : restOk ? 'rest' : apiOk ? 'api' : 'unavailable'

  const allErrors = methods.map((m) => m.error ?? '').join(' ')
  const none = !sslOk && !restOk && !apiOk
  return {
    selected,
    methods,
    fullyUnreachable: none,
    authFailed: none && isAuthFailure({ message: allErrors }),
  }
}

/**
 * Runs one command over whichever transport the probe selected.
 *
 * A caller that already knows the method can skip the probe and go straight
 * here, which matters for the worker polling loop: probing every cycle would
 * triple the traffic to a 32 MB RB941 for no benefit.
 */
export async function runCommand(
  endpoint: RouterEndpoint,
  method: ConnectionMethod,
  command: string,
  params: Record<string, string> = {},
  factory: ChannelFactory = websocketChannel,
): Promise<{ rows: Record<string, string>[]; method: ConnectionMethod; latencyMs: number }> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT
  const started = Date.now()
  if (method === 'rest') {
    const rows = await restCommand(endpoint, command, params, timeoutMs)
    return { rows, method, latencyMs: Date.now() - started }
  }
  // The probe never selects `ssh`, so anything reaching here is an API
  // transport. Guarding beats casting: the assumption stays visible.
  if (method !== 'api' && method !== 'api_ssl') {
    throw new RouterConnectError(
      `"${method}" is not a command transport.`, method, undefined, false)
  }
  const api = await openSession(endpoint, method, factory, timeoutMs)
  try {
    const rows = await api.execute(command, params)
    return { rows, method, latencyMs: Date.now() - started }
  } finally {
    api.close()
  }
}
