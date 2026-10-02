// =============================================================================
//  Router client for the worker.
//
//  This is what makes the worker worth running as a long-lived process. It keeps
//  one authenticated socket per router and reuses it across polls, which on a
//  32 MB RB941-2nD is the difference between a healthy device and one that
//  visibly stutters while the platform polls it.
//
//  Responsibilities:
//    * keep the session, reconnect when the router reboots
//    * fall back to another transport if the chosen one stops working
//    * record which method was actually used, so nothing reports a method it did
//      not confirm
//
//  Deliberately not here: any decision about which command to run. That belongs
//  to the job handlers, which are testable without a socket.
// =============================================================================

import { RawApiChannel } from './raw-channel.ts'
import {
  RouterOsApi, RouterConnectError, isAuthFailure,
  type ConnectionMethod,
} from './session.ts'
import { restCommand } from './rest.ts'

export interface RouterTarget {
  nodeId: string
  ispId: string
  name: string
  host: string
  apiPort: number
  apiSslPort: number
  restPort: number
  username: string
  password: string
  timeoutMs: number
}

export interface CommandResult {
  rows: Record<string, string>[]
  method: ConnectionMethod
  latencyMs: number
  /** False when the password crossed the network without TLS. */
  encrypted: boolean
}

type ApiMethod = 'api' | 'api_ssl'

interface CachedSession {
  api: RouterOsApi
  channel: RawApiChannel
  method: ApiMethod
  usedAt: number
  failures: number
}

/**
 * How long a session may idle before it is dropped.
 *
 * RouterOS closes an idle API socket after about five minutes. Reusing a dead
 * socket is worse than opening a new one, so the cache expires ahead of that.
 */
const SESSION_IDLE_MS = 120_000

/**
 * Order transports are tried in.
 *
 * `api_ssl` first because it is encrypted and works from RouterOS 6.49 up.
 * `api` last because it is unencrypted: it exists on every device including the
 * RB941-2nD, but it is only reached when nothing else answered, and the fact
 * that it was used is recorded so the panel can say so.
 *
 * REST is not in this list. It is stateless and therefore has no session to
 * keep, and it only exists on 7.1+, so it is tried after the API methods fail
 * and only over HTTPS.
 */
const API_ORDER: ApiMethod[] = ['api_ssl', 'api']

export class RouterClient {
  private readonly sessions = new Map<string, CachedSession>()
  private readonly preferred = new Map<string, ApiMethod>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Runs one command, reusing a live session when there is one. */
  async run(
    target: RouterTarget,
    command: string,
    params: Record<string, string> = {},
  ): Promise<CommandResult> {
    const started = this.now()
    const cached = this.sessions.get(target.nodeId)

    if (cached && this.usable(cached)) {
      try {
        const rows = await cached.api.execute(command, params)
        cached.failures = 0
        cached.usedAt = this.now()
        return this.result(rows, cached.method, started)
      } catch (err) {
        cached.failures += 1
        // A session that has failed twice is not worth another try. One failure
        // is tolerated because a router reboot mid-command is routine.
        if (cached.failures >= 2 || !isTransient(err)) this.dropSession(target.nodeId)
        else throw err
      }
    }

    return this.connectAndRun(target, command, params, started)
  }

  private result(
    rows: Record<string, string>[],
    method: ConnectionMethod,
    started: number,
  ): CommandResult {
    return {
      rows,
      method,
      latencyMs: this.now() - started,
      // Only api_ssl and REST-over-HTTPS protect the password in transit.
      encrypted: method === 'api_ssl' || method === 'rest',
    }
  }

  private usable(cached: CachedSession): boolean {
    if (cached.api.isClosed) return false
    if (!cached.channel.alive) return false
    return this.now() - cached.usedAt <= SESSION_IDLE_MS
  }
/**
   * Opens a session and runs the command, falling back through the transports.
   *
   * The order matches the Edge Function's, so a router managed by either path
   * ends up on the same method and the platform's records stay meaningful.
   */
  private async connectAndRun(
    target: RouterTarget,
    command: string,
    params: Record<string, string>,
    started: number,
  ): Promise<CommandResult> {
    const tried = new Set<ApiMethod>()
    const order: ApiMethod[] = []
    const preferred = this.preferred.get(target.nodeId)
    if (preferred) order.push(preferred)
    for (const m of API_ORDER) if (!order.includes(m)) order.push(m)

    let lastError: Error | null = null
    for (const method of order) {
      if (tried.has(method)) continue
      tried.add(method)
      try {
        return await this.openAndRun(target, method, command, params, started)
      } catch (err) {
        // `catch` gives `unknown`; every throw in this module is an Error, but
        // an unknown from a transport must not escape as-is.
        lastError = err instanceof Error ? err : new Error(String(err))
        // Wrong credentials fail identically on every transport, so trying the
        // next one only wastes the router's time.
        if (isAuthFailure(lastError)) break
      }
    }

    // REST last, and only over HTTPS. A plain-HTTP REST call would put the
    // router password on the wire, which is not an acceptable fallback.
    try {
      const rows = await restCommand(
        { host: target.host, restPort: target.restPort, restScheme: 'https',
          username: target.username, password: target.password },
        command, params, target.timeoutMs,
      )
      return this.result(rows, 'rest', started)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }

    throw lastError ?? new RouterConnectError('No transport answered.')
  }

  private async openAndRun(
    target: RouterTarget,
    method: ApiMethod,
    command: string,
    params: Record<string, string>,
    started: number,
  ): Promise<CommandResult> {
    const channel = await RawApiChannel.open({
      host: target.host,
      port: method === 'api_ssl' ? target.apiSslPort : target.apiPort,
      secure: method === 'api_ssl',
      timeoutMs: target.timeoutMs,
    })

    // The session owns the RouterOsApi instance, so the channel's sink is
    // attached after construction and forwards straight into it.
    let api: RouterOsApi | null = null
    channel.attach({
      onBytes: (chunk) => api?.ingest(chunk),
      onClosed: (reason) => {
        // `null` means a clean close; a reason means the socket died and every
        // in-flight command must fail rather than hang until its timeout.
        if (reason !== null) api?.ingest(null)
      },
    })

    const session = await RouterOsApi.open(
      channel, target.username, target.password, { timeoutMs: target.timeoutMs },
    )
    api = session

    const cached: CachedSession = {
      api: session, channel, method, usedAt: this.now(), failures: 0,
    }
    this.sessions.set(target.nodeId, cached)
    this.preferred.set(target.nodeId, method)

    try {
      const rows = await session.execute(command, params)
      cached.usedAt = this.now()
      return this.result(rows, method, started)
    } catch (err) {
      this.dropSession(target.nodeId)
      throw err
    }
  }

  dropSession(nodeId: string): void {
    const cached = this.sessions.get(nodeId)
    if (!cached) return
    try { cached.api.close() } catch { /* already gone */ }
    this.sessions.delete(nodeId)
  }

  /** Closes every session. Used on shutdown so no socket is orphaned. */
  closeAll(): void {
    for (const nodeId of [...this.sessions.keys()]) this.dropSession(nodeId)
  }

  /** Live session count, for the health endpoint. */
  get openSessions(): number {
    return this.sessions.size
  }
}

/** A failure worth retrying on another transport, rather than a permanent one. */
function isTransient(err: unknown): boolean {
  return err instanceof RouterConnectError && err.retryable
}