// =============================================================================
//  MikroTik RouterOS REST API client.
//
//  Used by the `mikrotik` and `mikrotik-poll` Edge Functions. Runs on Deno, so
//  it uses only Web Crypto - no Node built-ins.
//
//  RouterOS REST is HTTP Basic auth against
//    http://<host>:<port>/rest/<command>
//  Every call carries a short timeout: routers are frequently firewalled or
//  powered off, and a poll loop must not hang on an unreachable device.
// =============================================================================

const DEFAULT_TIMEOUT_MS = 8000

export interface RouterCredentials {
  host: string
  port: number
  username: string
  password: string
}

export class RouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'RouterError'
  }
}

function basicAuth(username: string, password: string): string {
  return 'Basic ' + btoa(username + ':' + password)
}

/** Runs one RouterOS REST command and returns its rows. */
export async function ros(
  creds: RouterCredentials,
  command: string,
  params: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, string>[]> {
  const url = `http://${creds.host}:${creds.port}/rest/${command}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds.username, creds.password),
        'Content-Type': 'text/plain',
      },
      body: Object.entries(params).map(([k, v]) => `${k}=${v}`).join('\n'),
      signal: ac.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RouterError(`Timed out after ${timeoutMs}ms`)
    }
    throw new RouterError(`Cannot reach ${creds.host}:${creds.port} - ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const hint =
      res.status === 401 ? 'check the username and password'
        : res.status === 404 ? 'the REST API is disabled on this router'
        : `HTTP ${res.status}`
    throw new RouterError(`${command} failed: ${hint}`, res.status)
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

export interface RouterTelemetry {
  identity: string | null
  model: string | null
  serial: string | null
  version: string | null
  uptimeSeconds: number | null
  cpuLoadPercent: number | null
  ramUsedMb: number | null
  ramTotalMb: number | null
  freeHddMb: number | null
  activeUsers: number
  temperatureC: number | null
}

/** "1w2d3h4m5s" -> seconds. */
export function parseUptime(text: string | null): number | null {
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

const toNum = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Reads identity, resources and the active HotSpot user count.
 *
 * The resource and user calls are independent so a router whose account has
 * restricted policies still reports whatever it does allow. The identity call
 * is the liveness probe and is deliberately NOT swallowed.
 */
export async function readTelemetry(
  creds: RouterCredentials,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RouterTelemetry> {
  const call = (cmd: string, params?: Record<string, string>) =>
    ros(creds, cmd, params, timeoutMs)

  let identities: Record<string, string>[]
  try {
    identities = await call('/system/identity/print')
  } catch (err) {
    throw err instanceof RouterError ? err : new RouterError('Router did not respond.')
  }
  if (!identities || identities.length === 0) {
    throw new RouterError('Router answered but returned no identity. Check the credentials.')
  }

  const [resources, users] = await Promise.all([
    call('/system/resource/print').catch(() => [] as Record<string, string>[]),
    call('/ip/hotspot/active/print').catch(() => [] as Record<string, string>[]),
  ])

  const identity = identities[0] ?? null
  const res = resources[0] ?? {}
  const totalBytes = toNum(res['total-memory'])
  const freeBytes = toNum(res['free-memory'])
  const mb = (n: number) => Math.round(n / 1048576)

  return {
    identity: identity?.name ?? null,
    model: res['board-name'] ?? null,
    serial: res['serial-number'] ?? null,
    version: res.version ?? null,
    uptimeSeconds: parseUptime(res.uptime ?? null),
    cpuLoadPercent: toNum(res['cpu-load']),
    ramUsedMb: totalBytes !== null && freeBytes !== null ? mb(totalBytes - freeBytes) : null,
    ramTotalMb: totalBytes !== null ? mb(totalBytes) : null,
    freeHddMb: toNum(res['free-hdd-space']) !== null ? mb(Number(res['free-hdd-space'])) : null,
    activeUsers: users.length,
    temperatureC: toNum(res['board-temperature']),
  }
}

export interface HotspotUser {
  id: string
  name: string
  address: string
  macAddress: string
  upBytes: number
  downBytes: number
  uptimeSeconds: number
  loginBy: string | null
}

/** Reads the HotSpot active-user table. */
export async function listHotspotUsers(
  creds: RouterCredentials,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HotspotUser[]> {
  const rows = await ros(creds, '/ip/hotspot/active/print', {}, timeoutMs)
  return rows.map((r) => ({
    id: r['.id'] ?? '',
    name: r.user ?? r['mac-address'] ?? 'unknown',
    address: r.address ?? '',
    macAddress: r['mac-address'] ?? '',
    upBytes: Number(r['bytes-up'] ?? 0) || 0,
    downBytes: Number(r['bytes-in'] ?? 0) || 0,
    uptimeSeconds: parseUptime(r.uptime) ?? 0,
    loginBy: r['login-by'] ?? null,
  }))
}

/** Ends a live session. RouterOS identifies it by its `.id`. */
export async function removeHotspotUser(
  creds: RouterCredentials,
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ros(creds, '/ip/hotspot/active/remove', { '.id': id }, timeoutMs)
}

/** Creates a HotSpot account (the voucher or subscriber login). */
export async function addHotspotUser(
  creds: RouterCredentials,
  user: { name: string; password: string; profile: string; limitUptime?: string; comment?: string },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ros(creds, '/ip/hotspot/user/add', {
    name: user.name,
    password: user.password,
    profile: user.profile,
    ...(user.limitUptime ? { 'limit-uptime': user.limitUptime } : {}),
    ...(user.comment ? { comment: user.comment } : {}),
  }, timeoutMs)
}

export async function removeHotspotAccount(
  creds: RouterCredentials,
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await ros(creds, '/ip/hotspot/user/remove', { '.id': id }, timeoutMs)
}

export async function listHotspotAccounts(
  creds: RouterCredentials,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Array<{ id: string; name: string; profile: string; disabled: string }>> {
  const rows = await ros(creds, '/ip/hotspot/user/print',
    { '.proplist': '.id,name,profile,disabled' }, timeoutMs)
  return rows.map((r) => ({
    id: r['.id'] ?? '',
    name: r.name ?? '',
    profile: r.profile ?? '',
    disabled: r.disabled ?? 'false',
  }))
}
