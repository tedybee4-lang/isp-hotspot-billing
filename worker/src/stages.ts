// =============================================================================
//  Staged provisioning, executed by the worker.
//
//  This is the module that makes the router actually configured. Every other
//  part of the platform can tell you a router exists; only this one changes it.
//
//  HOW A STAGE RUNS
//  ----------------
//  The job handler is called with ONE stage name. It:
//
//    1. re-reads the stage table, so it starts from the real recorded state
//       rather than from what the previous run believed
//    2. claims the stage (running), which the database refuses out of order
//    3. applies the configuration over the live RouterOS API
//    4. records the outcome with what the router actually returned
//
//  Splitting it this way - one stage per job claim, not thirteen stages inside
//  one job - is what makes a crash recoverable. The job lease expires, the job
//  is re-claimed, and the handler asks the database which stage is next instead
//  of guessing. A worker that died halfway through RADIUS resumes at RADIUS.
//
//  WHY THE WORKER AND NOT THE BROWSER
//  ----------------------------------
//  Because the worker holds a persistent authenticated socket to the router and
//  the browser does not. Configuration applied from a browser would need the
//  user's ISP credentials in their tab, and would die the moment they closed it.
//
//  WHAT A STAGE MAY DO
//  -------------------
//  Create what is missing, update what is ours, verify that it took. Never
//  remove, never disable, never rewrite an object it does not own. The router
//  may be carrying paying customers, and a provisioning run is not a licence to
//  reset it.
// =============================================================================

import { RouterConnectError } from './session.ts'
import type { RouterClient, RouterTarget } from './router-client.ts'

/** The tag written on everything this platform creates. */
export const OWNER = 'ISPFlow'
/** The legacy tag, still recognised so an old router is not duplicated. */
export const LEGACY_OWNER = 'NETISP'

/**
 * Does this row belong to the platform, under EITHER tag?
 *
 * Both, deliberately. A router provisioned by an earlier release carries
 * NETISP on every object it created. Treating those as foreign would make this
 * platform believe it owns nothing and create a second copy of everything -
 * the exact failure idempotency exists to prevent.
 */
export function isOwned(row: Record<string, string>): boolean {
  const c = (row.comment ?? '').trim()
  return (
    c.startsWith(`${OWNER}:`) || c.startsWith(`${OWNER} `) ||
    c.startsWith(`${LEGACY_OWNER}:`)
  )
}

/** The comment stamped on every object this platform creates. */
export const tag = (sessionTag: string): string => `${OWNER}:${sessionTag}`

/**
 * Finds our object with this name, whatever tag it carries.
 *
 * Name first: the name is the identifier the ISP recognises in the router's own
 * UI, and matching on it is what makes a re-run update rather than duplicate.
 * The tag check is not a filter - an object with the right name is ours to
 * update, because leaving it alone and creating a second one is worse.
 */
export function findOwned(
  rows: Record<string, string>[],
  name: string,
): Record<string, string> | null {
  return rows.find((r) => r.name === name) ?? null
}

// =============================================================================
//  Address pools.
//
//  PPPoE needs a local-address AND a remote-address range; a HotSpot server
//  needs a pool. Without them the ISP either types ranges into a wizard (and
//  gets them wrong, or overlaps them with the LAN) or provisioning fails with
//  "assign an address range" on a router that already has perfectly good ones.
//
//  So the pools are DISCOVERED, not asked for. This turns what the router
//  reported into a pair that is safe to use, and refuses rather than inventing.
// =============================================================================

export interface DiscoveredPool {
  name: string
  /** Verbatim from `/ip/pool/print`. Never rewritten, so nothing is fabricated. */
  ranges: string
  nextPool?: string | null
}

/**
 * One range inside a pool's `ranges` string.
 *
 * RouterOS stores a pool's ranges as a COMMA-separated list, not a single
 * range: `10.0.0.2-10.0.0.100,10.0.0.200-10.0.0.250`. Treating that whole string
 * as one range is the bug that made a perfectly good pool look unusable, and a
 * pool silently rejected for that reason is a pool the ISP is told to add again
 * on a router that already has one.
 */
export interface ParsedRange {
  from: string
  to: string
  /** Addresses spanned, inclusive. */
  size: number
}

/**
 * Parses one RouterOS range into an inclusive address count.
 *
 * Handles the shapes RouterOS actually emits:
 *   * `10.0.0.2-10.0.0.100`  a two-ended range
 *   * `10.0.0.5`             a single address
 *
 * Returns null for anything it cannot read. A null is a refusal, never a guess:
 * an address range that overlaps the LAN takes the router down.
 */
export function parseRange(text: string): ParsedRange | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null

  const parts = trimmed.split('-')
  if (parts.length === 2) {
    const from = parts[0].trim()
    const to = parts[1].trim()
    const a = toInt(from)
    const b = toInt(to)
    if (a === null || b === null || b < a) return null
    return { from, to, size: b - a + 1 }
  }
  if (parts.length === 1) {
    const single = parts[0].trim()
    const a = toInt(single)
    // A single address is a real, valid pool: RouterOS writes one this way when
    // the operator wants exactly one address.
    return a === null ? null : { from: single, to: single, size: 1 }
  }
  // Three or more hyphens is not a range.
  return null
}

/**
 * Every readable range in a pool's `ranges` string.
 *
 * Comma-separated, because that is how RouterOS stores more than one. Entries
 * that cannot be read are SKIPPED rather than failing the whole pool, so one
 * malformed entry does not discard a pool that also contains a good range.
 */
export function parseRanges(ranges: string): ParsedRange[] {
  if (!ranges || !ranges.trim()) return []
  const out: ParsedRange[] = []
  for (const entry of ranges.split(',')) {
    const parsed = parseRange(entry)
    if (parsed) out.push(parsed)
  }
  return out
}

/** "10.0.0.2-10.0.255.254" -> its endpoints, or null when unreadable. */
function splitRange(range: string): [string, string] | null {
  const parts = range.trim().split('-')
  if (parts.length !== 2) return null
  return [parts[0].trim(), parts[1].trim()]
}

/** IPv4 dotted quad to integer. Only dotted quad; RouterOS emits nothing else. */
function toInt(ip: string): number | null {
  const octets = ip.split('.')
  if (octets.length !== 4) return null
  let n = 0
  for (const o of octets) {
    const v = Number(o)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** Integer back to a dotted quad. */
function toIp(n: number): string {
  return [
    Math.floor(n / 16777216) % 256,
    Math.floor(n / 65536) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join('.')
}

/**
 * How many addresses a `ranges` string covers in total.
 *
 * Sums the parsed ranges. Null when NONE of them could be read, so a caller can
 * tell "no addresses" from "addresses I could not understand" - a difference
 * that decides whether provisioning proceeds or stops.
 */
export function rangeSize(ranges: string): number | null {
  const parsed = parseRanges(ranges)
  if (parsed.length === 0) return null
  return parsed.reduce((n, r) => n + r.size, 0)
}

/** A usable pair of ranges for PPPoE, or HotSpot's single pool. */
export interface ResolvedPools {
  local: string | null
  remote: string | null
  source: string | null
  /** The pools considered and rejected, so a failure explains itself. */
  rejected: Array<{ name: string; reason: string }>
}

/**
 * PPPoE needs enough addresses for its subscribers, and enough that the local
 * and remote ranges stay disjoint.
 *
 * The floor is deliberately small. Refusing a 3-address pool for a small branch
 * is correct, not a limitation: PPPoE cannot work with fewer addresses than it
 * has subscribers, and finding that out now beats handing the operator a router
 * that authenticates three customers and drops the fourth.
 */
export const MIN_PPP_ADDRESSES = 4

/**
 * Chooses the PPPoE local and remote ranges from what the router already has.
 *
 * Selection, in order:
 *   1. A pool this platform already owns wins outright. Re-provisioning must land
 *      on the SAME ranges, or every subscriber's address changes and their lease
 *      and any IP-bound firewall rule break with it.
 *   2. Otherwise the largest qualifying pool, preferring one not already serving
 *      HotSpot.
 *   3. The chosen range is split in half: local on the first, remote on the
 *      second. That is the convention every MikroTik deployment uses and it
 *      guarantees the two are disjoint.
 *
 * Returns nulls rather than a guess when nothing qualifies. A wrong range here
 * overlaps the LAN or the upstream and takes the router down, which is strictly
 * worse than asking the operator to supply one.
 */
export function resolvePppPools(
  pools: DiscoveredPool[],
  opts: { minimum?: number } = {},
): ResolvedPools {
  const minimum = opts.minimum ?? MIN_PPP_ADDRESSES
  const rejected: Array<{ name: string; reason: string }> = []

  const usable = pools
    .map((pool) => {
      const size = rangeSize(pool.ranges)
      if (size === null) {
        rejected.push({ name: pool.name, reason: 'the range could not be read' })
        return null
      }
      if (size < minimum) {
        rejected.push({
          name: pool.name,
          reason: `only ${size} address(es); PPPoE needs at least ${minimum}`,
        })
        return null
      }
      return { pool, size }
    })
    .filter((x): x is { pool: DiscoveredPool; size: number } => x !== null)

  if (usable.length === 0) return { local: null, remote: null, source: null, rejected }

  // Ours first, so a re-provisioning lands on the SAME ranges and no subscriber's
  // address changes underneath them.
  const chosen = usable.find((u) => u.pool.name.startsWith(OWNER))
    ?? usable.sort((a, b) => b.size - a.size)[0]

  // Split the LARGEST individual range, not the pool as a whole. A comma-separated
  // pool is several ranges the router keeps distinct; merging them into one span
  // and re-emitting it would both widen the pool beyond what the operator
  // configured and hand out addresses that sit in the gaps between the ranges.
  const ranges = parseRanges(chosen.pool.ranges).sort((a, b) => b.size - a.size)
  const widest = ranges.find((r) => Math.floor(r.size / 2) >= 2)
  if (!widest) {
    return { local: null, remote: null, source: chosen.pool.name, rejected }
  }

  const start = toInt(widest.from)!
  const half = Math.floor(widest.size / 2)

  return {
    // An odd size gives the extra address to local.
    local: `${toIp(start)}-${toIp(start + half - 1)}`,
    remote: `${toIp(start + half)}-${toIp(start + widest.size - 1)}`,
    source: chosen.pool.name,
    rejected,
  }
}

/**
 * Chooses the HotSpot pool.
 *
 * Prefers a platform-owned pool, then the largest one that is not the PPPoE
 * source. HotSpot and PPPoE sharing a range is a common cause of "the session
 * drops every time someone dials in", so they are kept apart wherever the router
 * allows it.
 */
export function resolveHotspotPool(
  pools: DiscoveredPool[],
  opts: { exclude?: string | null } = {},
): { pool: string | null; source: string | null } {
  const usable = pools
    .filter((p) => (p.nextPool ?? null) === null)
    .filter((p) => p.name !== (opts.exclude ?? null))
    .map((p) => ({ pool: p, size: rangeSize(p.ranges) ?? 0 }))
    .filter((x) => x.size >= 2)
    .sort((a, b) => b.size - a.size)

  if (usable.length === 0) return { pool: null, source: null }
  const ours = usable.find((u) => u.pool.name.startsWith(OWNER))
  return { pool: (ours ?? usable[0]).pool.name, source: (ours ?? usable[0]).pool.name }
}

// APPEND_POOLS_2
//
//  Every value comes from the database or from the router. Nothing is hardcoded:
//  no IP ranges, no DNS, no package speeds. An ISP who edits a package gets the
//  new value on the next sync, with no redeploy.
// =============================================================================

export interface StagePlan {
  id: string
  name: string
  kind: 'hotspot' | 'pppoe' | 'fiber'
  speed_down: string
  speed_up: string
  shared_users: number
  data_limit: string | null
  is_active: boolean
}

export interface StageCustomer {
  id: string
  username: string
  password_plain: string | null
  plan_name: string | null
  /**
   * Which service this customer's plan actually delivers.
   *
   * This is what stops a prepaid HotSpot subscriber being given a PPPoE
   * dial-in account they never bought. Pushing every active customer to every
   * SELECTED service is not "mirroring the database" - it is granting service
   * the entitlement does not include, and a customer who finds a PPPoE account
   * on a router is looking at an unpaid dial-in service.
   */
  service: 'hotspot' | 'pppoe' | 'both' | 'none'
  /** Only active entitlements are synchronised. Never derived from payment. */
  is_active: boolean
}

export interface StageSession {
  id: string
  ispId: string
  nodeId: string
  role: 'hotspot' | 'pppoe' | 'both'
  tag: string
  wanInterface: string | null
  hotspotInterfaces: string[]
  pppoeInterfaces: string[]
  managementInterfaces: string[]
  tunnelRequired: boolean
  /** From /system/resource. The second signal for capability decisions. */
  routerosVersion: string | null
  dns: string[]
  radiusServer: string | null
  radiusEnabled: boolean
  /**
   * The RADIUS shared secret, held in memory only for the duration of the stage.
   *
   * It is written to the router and nowhere else - never into a stage detail, a
   * job result, an event row or an error message. That is why the StageContext
   * carries it separately from the serialisable session row.
   */
  radiusSecret: string | null
  sessionTimeoutMin: number
  idleTimeoutMin: number
  /** Pools resolved from DISCOVERY, never invented here. */
  pppLocal: string | null
  pppRemote: string | null
  hotspotPool: string | null
}

export interface StageContext {
  session: StageSession
  plans: StagePlan[]
  customers: StageCustomer[]
}

export type StageStatus =
  | 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unsupported'

export interface StageOutcome {
  status: StageStatus
  detail?: Record<string, unknown>
  error?: string | null
  skipReason?: string | null
  /** False when the failure is permanent and a retry would only waste effort. */
  retryable?: boolean
}

/** One stage: given the router and the context, change what needs changing. */
export type StageFn = (
  client: RouterClient,
  target: RouterTarget,
  ctx: StageContext,
) => Promise<StageOutcome>

/**
 * The parameters that address ONE existing row for a `/set` or `/remove`.
 *
 * THIS IS THE SINGLE MOST IMPORTANT CONVENTION IN THIS FILE, and getting it
 * wrong is invisible to every test here because the mock accepts any key.
 *
 * RouterOS's API encodes parameters as `=key=value` words. To address a
 * specific row you pass `.id` as the KEY: `.id=*A` means "the row whose id is
 * *A". There is no `numbers` parameter - `numbers` is a VALUE property that
 * appears in `print` output, and passing it as a key asks RouterOS to set a
 * property called "numbers", which either errors or matches more rows than you
 * meant. That is why every `/set` here goes through this helper.
 *
 * `worker/src/handlers.ts` already used `'.id'` for `/radius/incoming/set`;
 * this makes it a rule rather than a coincidence.
 */
export function addressing(row: Record<string, string>): Record<string, string> {
  const id = row['.id']
  return id ? { '.id': id } : {}
}

/**
 * Runs a command and keeps the error instead of throwing.
 *
 * A stage must be able to say WHICH probe failed. Swallowing an error and
 * reporting success is the single worst thing this module could do, so every
 * command goes through here and the error travels with it.
 */
export async function attempt(
  client: RouterClient,
  target: RouterTarget,
  command: string,
  params: Record<string, string> = {},
): Promise<{ ok: boolean; rows: Record<string, string>[]; error: string | null }> {
  try {
    const res = await client.run(target, command, params)
    return { ok: true, rows: res.rows, error: null }
  } catch (err) {
    return {
      ok: false, rows: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// =============================================================================
//  Call recording, for hardware diagnosis.
//
//  When a real router is finally available and a stage fails at 2am on a device
//  400 km away, the only useful question is "what exactly did we send it".
//
//  NEVER LOGGED, from any path: passwords, API secrets, RADIUS shared secrets,
//  WireGuard private keys, subscriber credentials, provisioning/discovery tokens.
//  The rule is enforced by REDACTING here rather than by trusting each call site
//  to pass something safe, because a call site added later will not remember.
// =============================================================================

/** Parameter names whose VALUE is replaced before anything is recorded. */
const SECRET_PARAMS = new Set([
  'password', 'passwd', 'secret', 'shared-secret', 'old-secret', 'new-secret',
  'private-key', 'public-key', 'pre-shared-key', 'psk', 'token', 'api-key',
  'apikey', 'pass', 'user-password', 'radius-secret', 'authentication-key',
  'private_key', 'shared_secret', 'passphrase', 'wpa2-pre-shared-key',
])

/** True when a parameter's value must never be recorded. */
export function isSecretParam(name: string): boolean {
  return SECRET_PARAMS.has(name.toLowerCase())
}

/**
 * A copy of `params` with every credential replaced by a marker.
 *
 * The KEY is kept on purpose: knowing that `password` was sent tells an operator
 * far more about a failure than seeing it silently missing.
 */
export function redactParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = isSecretParam(key) ? '[redacted]' : value
  }
  return out
}

/** One recorded command: enough to diagnose, nothing sensitive. */
export interface RouterOsCall {
  at: string
  command: string
  operation: string
  /** Sanitised: a credential key is present, its value is [redacted]. */
  params: Record<string, string>
  ok: boolean
  rows?: number
  durationMs: number
  error?: string
}

/**
 * Classifies a RouterOS path so "did this stage try to REMOVE anything" is
 * answerable from the recorded calls alone, without reading the stage source.
 * That question has to be answerable on a live router after the fact.
 */
export function operationOf(command: string): string {
  const last = command.split('/').pop() ?? ''
  if (['print', 'add', 'set', 'remove', 'enable', 'disable', 'save']
    .includes(last)) return last
  return 'other'
}

/**
 * The RouterOS calls a stage made, sanitised.
 *
 * Returned in the stage detail so `provisioning_events` carries the evidence.
 * A stage that fails on hardware and has no record of what it sent is the
 * hardest kind of bug to fix, and the record is the cheapest insurance there is.
 */
export async function recordCalls(
  client: RouterClient,
  target: RouterTarget,
  command: string,
  params: Record<string, string> = {},
): Promise<{ ok: boolean; rows: Record<string, string>[]; error: string | null; call: RouterOsCall }> {
  const started = Date.now()
  const safeParams = redactParams(params)
  try {
    const res = await client.run(target, command, params)
    return {
      ok: true, rows: res.rows, error: null,
      call: {
        at: new Date().toISOString(),
        command,
        operation: operationOf(command),
        params: safeParams,
        ok: true,
        rows: res.rows.length,
        durationMs: Date.now() - started,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false, rows: [], error: message,
      call: {
        at: new Date().toISOString(),
        command,
        operation: operationOf(command),
        params: safeParams,
        ok: false,
        durationMs: Date.now() - started,
        error: message,
      },
    }
  }
}

/**
 * RouterOS reports booleans as the strings "true"/"yes", and the API sometimes
 * as "1". Guessing here would mean a disabled interface reading as enabled.
 */
export const truthy = (v: string | undefined): boolean =>
  v === 'true' || v === 'yes' || v === '1'

// =============================================================================
//  Speeds.
//
//  The SAME rules as supabase/functions/_shared/profiles.ts, restated here
//  because the worker cannot import a Deno module. They are asserted equal by
//  worker/src/stages.test.ts, so the two cannot drift silently - a profile that
//  the wizard previewed as 20M/5M must not arrive on the router as something
//  else.
//
//  Every value comes from the database row the ISP edited. There is no ladder of
//  known speeds anywhere: a package raised from 3 Mbps to 20 Mbps is written as
//  20M on the next sync with no code change and no redeploy.
// =============================================================================

/**
 * A typed speed, in megabits per second.
 *
 * Returns null when the text carries no number. Null is a signal to STOP, not to
 * default: an unparseable speed on a metered package means the profile must not
 * be created at all, because a profile with no rate limit is unlimited
 * bandwidth sold as a capped package.
 */
export function parseSpeedMbps(text: string | null | undefined): number | null {
  if (!text) return null
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m|g)?/i.exec(text.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (m[2] ?? 'm').toLowerCase()
  if (unit === 'k') return value / 1000
  if (unit === 'g') return value * 1000
  return value
}

/**
 * A RouterOS rate-limit figure from a megabit value: 20 -> "20M", 0.5 -> "500k".
 *
 * The G threshold is 1_000_000 kbit. Dividing by 100_000 instead turns 100 Mbps
 * into "1G" and 1000 Mbps into "10G" - selling a 1 Gbps package as 10 Gbps,
 * which is the single most damaging thing a provisioning bug can do to an ISP's
 * reputation with their customers.
 */
export function formatRate(mbps: number): string {
  const kbit = Math.round(mbps * 1000)
  if (kbit >= 1_000_000) return `${Math.round(kbit / 1_000_000)}G`
  if (kbit >= 1000) return `${Math.round(kbit / 1000)}M`
  return `${kbit}k`
}

/**
 * The full RouterOS rate-limit string, e.g. "20M/5M", or "10M" when symmetric.
 *
 * `formatRate` already returns a suffixed figure, so nothing is appended here.
 * Appending another "M" produced "20MM", which RouterOS rejects outright.
 */
export function rateLimit(downMbps: number, upMbps: number): string {
  const d = formatRate(downMbps)
  const u = formatRate(upMbps)
  return d === u ? d : `${d}/${u}`
}

/**
 * The characters dropped from a plan name before it becomes a RouterOS object
 * name. A plan name is free text the ISP typed; it ends up in an import file, an
 * export and a support ticket, and a newline or a comment delimiter in it
 * changes what the whole script means.
 */
const UNSAFE = new Set(['*', '/', ';', '$', '"', '\u0027', '\u0060', '{', '}', '\\'])

/** The safe RouterOS object name for a plan, or null when it cannot be made safe. */
export function safeName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f]/g, ' ')      // control characters, incl. newline
    .split('')
    .filter((ch) => !UNSAFE.has(ch))
    .join('')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return cleaned.length > 0 ? cleaned : null
}

/**
 * DISCOVERY.
 *
 * Nothing is written here. The router already reported what it is, and this
 * stage records that the report exists and is usable. If the interfaces the
 * wizard said it would use are not actually present, that is caught HERE rather
 * than three stages later after something has been configured.
 *
 * A reported-but-missing interface is a FAILED discovery, not a warning: it
 * means the operator picked a port from a list the router no longer has, and
 * applying the rest of the configuration could take the router offline.
 */
export const discoveryStage: StageFn = async (client, target, ctx) => {
  const res = await attempt(client, target, '/interface/print')
  if (!res.ok) {
    return {
      status: 'failed',
      error: `The router would not list its interfaces: ${res.error}`,
      retryable: true,
    }
  }

  const live = new Set(res.rows.map((r) => r.name).filter(Boolean))
  const missing: string[] = []
  for (const port of [
    ...(ctx.session.wanInterface ? [ctx.session.wanInterface] : []),
    ...ctx.session.hotspotInterfaces,
    ...ctx.session.pppoeInterfaces,
    ...ctx.session.managementInterfaces,
  ]) {
    if (port && !live.has(port)) missing.push(port)
  }

  if (missing.length > 0) {
    return {
      status: 'failed',
      error: `These selected ports no longer exist on the router: ${missing.join(', ')}. `
        + `It currently has ${[...live].slice(0, 12).join(', ')}. Re-run discovery and `
        + 'choose the ports again - applying the configuration now could take the '
        + 'router offline.',
      retryable: false,
      detail: { missing, live: [...live] },
    }
  }

  return {
    status: 'success',
    detail: {
      interfaces: res.rows.length,
      // What the router already had, so a later stage can be idempotent about it.
      legacy_tagged: res.rows.filter((r) => (r.comment ?? '').startsWith(LEGACY_OWNER)).length,
      ispflow_tagged: res.rows.filter((r) => isOwned(r)).length,
    },
  }
}

/**
 * BACKUP.
 *
 * Before ANY mutating stage. A binary backup, because that is the one RouterOS
 * can actually restore, plus a text export for the ISP to diff.
 *
 * The file is written to the router's own filesystem and NEVER uploaded. A
 * backup contains every PPPoE and RADIUS secret on the device; this platform has
 * no business copying those into a database it replicates and backs up itself.
 *
 * No password on the backup: RouterOS would encrypt it with a secret this
 * platform would then have to hold, and a backup nobody can decrypt is not a
 * backup.
 */
export const backupStage: StageFn = async (client, target, ctx) => {
  const base = `ispflow-backup-${ctx.session.tag}`
  const name = `${base}-binary.backup`

  const existing = await attempt(client, target, '/file/print')
  if (!existing.ok) {
    return {
      status: 'failed',
      error: `The router would not list its files, so a backup cannot be confirmed: ${existing.error}`,
      retryable: true,
    }
  }

  // Already there from an earlier attempt at this session. Skipping is correct:
  // a second backup would overwrite the one that predates the failure we might
  // need to roll back to.
  if (existing.rows.some((r) => r.name === name)) {
    return { status: 'success', detail: { filename: name, already_present: true } }
  }

  const saved = await attempt(client, target, '/system/backup/save', { name })
  if (!saved.ok) {
    return {
      status: 'failed',
      // Storage-full is the common cause and retrying will not fix it.
      error: `The router could not write a backup ("${name}"): ${saved.error}. `
        + 'Free space on the router or reduce its log level, then retry. Nothing '
        + 'has been changed on this router yet.',
      retryable: false,
    }
  }

  // Confirm it landed. A save that returned OK but produced no file is exactly
  // the case where proceeding would remove the ISP's way back.
  const after = await attempt(client, target, '/file/print')
  const file = after.ok ? after.rows.find((r) => r.name === name) ?? null : null

  if (!file) {
    return {
      status: 'failed',
      error: `The router reported saving "${name}" but no such file exists. `
        + 'Provisioning stopped here rather than changing a router with no way back.',
      retryable: true,
    }
  }

  return { status: 'success', detail: { filename: name, size_bytes: file.size ?? null } }
}

/**
 * CONNECTIVITY.
 *
 * The worker needs the RouterOS API to apply anything at all, and it is talking
 * to it right now - so the useful thing to check is that the service is enabled,
 * and to leave it exactly as it is, including any address restriction the ISP
 * put on it. This stage never re-opens a service the operator deliberately
 * closed: it can report, it does not override.
 */
export const connectivityStage: StageFn = async (client, target) => {
  const services = await attempt(client, target, '/ip/service/print')
  if (!services.ok) {
    return {
      status: 'failed',
      error: `The router would not report its services: ${services.error}`,
      retryable: true,
    }
  }

  const api = services.rows.find((r) => r.name === 'api')
  if (!api) {
    return {
      status: 'failed',
      error: 'This router has no RouterOS API service, so the platform cannot manage '
        + 'it. Enable /ip service "api" on the router and retry.',
      retryable: false,
    }
  }
  if (api.disabled === 'true') {
    // We reached the router over that very API, so it cannot really be disabled.
    // The row and the reality disagreeing is worth refusing over rather than
    // papering over.
    return {
      status: 'failed',
      error: 'The RouterOS API reports itself as disabled, yet this session reached '
        + 'the router through it. The router configuration is inconsistent; check '
        + '/ip service before retrying.',
      retryable: false,
    }
  }

  return {
    status: 'success',
    detail: {
      api_port: api.port ?? null,
      enabled_services: services.rows.filter((r) => !truthy(r.disabled)).map((r) => r.name),
    },
  }
}

/**
 * What a router can actually do about WireGuard.
 *
 * The four states are kept apart on purpose. Collapsing "unsupported" into
 * "supported but empty" is how a RouterOS 6 box with no WireGuard at all gets a
 * tunnel created, or - worse - gets a REQUIRED tunnel reported as merely absent,
 * and the router is declared healthy while nobody can reach it.
 */
export type WireGuardSupport =
  /** The menu exists and returned rows. */
  | { kind: 'supported'; interfaces: number }
  /** The menu exists and is empty. Supported, nothing configured yet. */
  | { kind: 'supported-empty' }
  /** The menu does not exist. This firmware cannot do WireGuard. */
  | { kind: 'unsupported'; reason: string }
  /** The probe failed for some other reason: permissions, timeout, overload. */
  | { kind: 'unknown'; reason: string }

/**
 * Classifies a WireGuard probe from TWO independent signals, because one is not
 * enough:
 *
 *   * The command result. An empty list from a menu that does not exist looks
 *     identical to a supported menu with nothing configured.
 *   * The reported RouterOS version. WireGuard arrived in 7.1, so older firmware
 *     CANNOT support it regardless of what the command returned.
 *
 * Version is the tie-breaker in the case that matters: old firmware answering
 * `/interface/wireguard/print` with an empty list instead of rejecting the path.
 * Believing the empty list there would create a tunnel on a device that cannot
 * carry it.
 *
 * A failed probe is split two ways on purpose. "No such command" means the
 * feature is missing; a timeout does NOT, and calling a timeout "unsupported"
 * would report a working router as incapable.
 */
export function classifyWireGuard(args: {
  probe: { ok: true; rows: Record<string, string>[] } | { ok: false; error: string | null }
  /** From /system/resource version; null when unknown, which is NOT support. */
  versionSupports: boolean | null
  version: string | null
}): WireGuardSupport {
  const { probe, versionSupports, version } = args

  if (!probe.ok) {
    const reason = probe.error ?? 'the probe did not answer'
    if (/no such command|unknown parameter|no such item|not found|invalid/i.test(reason)) {
      return { kind: 'unsupported', reason }
    }
    return { kind: 'unknown', reason }
  }

  if (versionSupports === false) {
    return {
      kind: 'unsupported',
      reason: `RouterOS ${version ?? 'older than 7.1'} predates WireGuard support`,
    }
  }

  return probe.rows.length > 0
    ? { kind: 'supported', interfaces: probe.rows.length }
    : { kind: 'supported-empty' }
}

/** "7.14.3 (stable)" -> true; "6.49.10" -> false; null -> null (unknown). */
export function versionSupportsWireGuard(version: string | null): boolean | null {
  if (!version) return null
  const m = /(\d+)\.(\d+)/.exec(version)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 7 || (major === 7 && minor >= 1)
}

/**
 * SECURE_TUNNEL (WireGuard).
 *
 * The rule this stage exists to enforce: a REQUIRED tunnel the router cannot
 * provide is a FAILURE, never "unsupported". Recording it as unsupported would
 * call an unreachable router healthy and let it through the ONLINE gate.
 *
 * An optional tunnel is different: if the ISP did not ask for one, or the
 * firmware predates WireGuard, this is UNSUPPORTED and provisioning continues.
 * A cheap RB951 that cannot do WireGuard is not a broken router.
 *
 * An INDETERMINATE probe is its own outcome and never becomes "supported". If we
 * could not find out and the tunnel is required, the stage fails: refusing to
 * proceed is recoverable, believing the router is unreachable is not.
 */
export const secureTunnelStage: StageFn = async (client, target, ctx) => {
  const probe = await attempt(client, target, '/interface/wireguard/print')
  const version = ctx.session.routerosVersion
  const support = classifyWireGuard({
    probe: probe.ok
      ? { ok: true, rows: probe.rows }
      : { ok: false, error: probe.error },
    versionSupports: versionSupportsWireGuard(version),
    version,
  })

  /** Not available. Required means the run stops; optional means it continues. */
  const unavailable = (reason: string): StageOutcome => (
    ctx.session.tunnelRequired
      ? {
        status: 'failed',
        error: 'WireGuard is required for this router, but it is not available: '
          + `${reason}. Without the tunnel the router cannot be managed, so `
          + 'provisioning stops here. Use RouterOS 7.1 or later, or turn the tunnel '
          + 'off and keep a management port reachable.',
        retryable: false,
        detail: { support },
      }
      : {
        status: 'unsupported',
        skipReason: `WireGuard is not available (${reason}), and no tunnel was required.`,
        detail: { support },
      })

  if (support.kind === 'unsupported') return unavailable(support.reason)
  if (support.kind === 'unknown') {
    // Never treated as support. An unanswered probe is not evidence either way.
    return unavailable(`the router did not answer the WireGuard probe: ${support.reason}`)
  }

  const name = `${OWNER}-${ctx.session.tag}`
  const existing = findOwned(probe.rows, name)

  if (existing) {
    // Already there. Re-running must NOT create a second tunnel: two WireGuard
    // interfaces with overlapping allowed-ips on one router break routing for
    // every customer behind it.
    return {
      status: 'success',
      detail: {
        interface: name, already_present: true,
        disabled: truthy(existing.disabled), support,
      },
    }
  }

  const added = await attempt(client, target, '/interface/wireguard/add', {
    name,
    // RouterOS spells this with a HYPHEN. `listen_port` is silently ignored by
    // the API on some firmware and rejected on others, which produces a tunnel
    // that exists but listens on nothing.
    'listen-port': '13231',
    comment: tag(ctx.session.tag),
  })
  if (!added.ok) {
    return {
      status: 'failed',
      error: ctx.session.tunnelRequired
        ? `The required WireGuard tunnel could not be created: ${added.error}`
        : `The optional WireGuard tunnel could not be created: ${added.error}`,
      // A busy port or a full table is worth another try; a permissions problem
      // is not, and repeating it would only fill the job log.
      retryable: /already|busy|timeout/i.test(added.error ?? ''),
      detail: { support },
    }
  }

  return { status: 'success', detail: { interface: name, created: true, support } }
}

/**
 * RADIUS.
 *
 * FreeRADIUS stays where it is. Nothing here moves accounting into this
 * platform, into Vercel or into a browser: the router is pointed at the ISP's
 * own RADIUS server and this stage only records that the pointing worked.
 *
 * If RADIUS is enabled for this ISP and the server cannot be set or cannot be
 * confirmed, this FAILS. A HotSpot or PPPoE service with no working RADIUS
 * authenticates nobody, and reporting that router healthy would tell an ISP
 * their subscribers are online when not one of them can log in.
 *
 * The shared secret goes to the router and nowhere else. It is never placed in a
 * stage detail, a job result, an event row, or an error string - an error is
 * built from the RouterOS message alone, which never contains the secret.
 */
export const radiusStage: StageFn = async (client, target, ctx) => {
  if (!ctx.session.radiusEnabled || !ctx.session.radiusServer) {
    // Local authentication only. A legitimate configuration, so skipped rather
    // than failed - but recorded, because an ISP who expected RADIUS and quietly
    // got local auth would otherwise have no way of knowing.
    return {
      status: 'skipped',
      skipReason: ctx.session.radiusServer
        ? 'RADIUS is switched off for this ISP; the router will use local accounts.'
        : 'No RADIUS server is configured for this ISP.',
      detail: { radius_enabled: false },
    }
  }

  const host = ctx.session.radiusServer
  const probe = await attempt(client, target, '/radius/print')

  if (!probe.ok) {
    return {
      status: 'failed',
      error: 'RADIUS is required for this ISP\'s HotSpot and PPPoE services, but this '
        + `router does not expose /radius: ${probe.error}. Subscribers would not be `
        + 'able to authenticate, so provisioning stops here.',
      retryable: false,
    }
  }

  // A router with an EMPTY RADIUS secret rejects every Access-Request, and the
  // router still accepts the configuration call. That is the failure this check
  // exists to prevent: provisioning would report success, the router would come
  // online, and not one subscriber could log in.
  if (!ctx.session.radiusSecret) {
    return {
      status: 'failed',
      error: 'RADIUS is switched on for this ISP, but no shared secret is stored for '
        + `this router, so it cannot authenticate against ${host}. Store the router's `
        + 'own RADIUS secret in the panel (it must match the secret for this router in '
        + 'FreeRADIUS clients.conf), then retry. Nothing has been changed on the router.',
      retryable: false,
    }
  }

  const name = `${OWNER}-${ctx.session.tag}`
  // The params object is sent to the router and then dropped. Nothing here is
  // ever serialised into a result.
  const params: Record<string, string> = {
    name,
    address: `${host}:1812`,
    comment: tag(ctx.session.tag),
    timeout: '1500ms',
  }
  if (ctx.session.radiusSecret) params['secret'] = ctx.session.radiusSecret

  // Prefer an object this platform owns; otherwise one already pointing at this
  // host, which is the ISP's own server they configured by hand.
  const existing = findOwned(probe.rows, name)
    ?? probe.rows.find((r) => (r.address ?? '').startsWith(host))

  if (existing) {
    const set = await attempt(client, target, '/radius/set', {
      ...addressing(existing),
      ...params,
    })
    if (!set.ok) {
      return {
        status: 'failed',
        error: `The existing RADIUS server (${host}) could not be updated: ${set.error}`,
        retryable: true,
      }
    }
    return { status: 'success', detail: { server: host, updated: true } }
  }

  const add = await attempt(client, target, '/radius/add', params)
  if (!add.ok) {
    return {
      status: 'failed',
      error: `The RADIUS server ${host} could not be configured: ${add.error}. `
        + 'Subscribers would not be able to authenticate, so provisioning stops here.',
      retryable: /timeout|temporarily|failed to accept/i.test(add.error ?? ''),
    }
  }

  // Confirm it is really there. An add that returned OK is not evidence the
  // router will use it, and this stage is what stands between the ISP and a
  // router that silently cannot authenticate anybody.
  const after = await attempt(client, target, '/radius/print')
  const found = after.ok ? findOwned(after.rows, name) : null
  if (!found) {
    return {
      status: 'failed',
      error: `RADIUS was added for ${host} but the router does not report it back. `
        + 'Provisioning stopped rather than continue with authentication that may not work.',
      retryable: true,
    }
  }

  return {
    status: 'success',
    detail: { server: host, created: true, disabled: truthy(found.disabled) },
  }
}

/**
 * HOTSPOT.
 *
 * Only the interfaces the ISP actually selected. A server is created on each
 * one; a HotSpot server already on that interface is updated rather than
 * duplicated, because two servers on one interface is a support call every time.
 *
 * A HotSpot server on an interface the ISP did NOT select is left completely
 * alone. It may be serving another branch, another ISP's reseller, or the
 * operator's own testing - and this stage has no business knowing which.
 */
export const hotspotStage: StageFn = async (client, target, ctx) => {
  const ifaces = ctx.session.hotspotInterfaces
  if (ifaces.length === 0) {
    return { status: 'skipped', skipReason: 'No HotSpot interface was selected.' }
  }

  const probe = await attempt(client, target, '/ip/hotspot/print')
  if (!probe.ok) {
    // No HotSpot package on this firmware. Optional, so not a failure.
    return {
      status: 'unsupported',
      skipReason: 'This firmware does not provide HotSpot.',
      detail: { error: probe.error },
    }
  }

  const servers = probe.rows
  const created: string[] = []
  const updated: string[] = []

  for (const iface of ifaces) {
    const name = `${OWNER}-${ctx.session.tag}-${iface}`
    const params: Record<string, string> = {
      name,
      interface: iface,
      'address-pool': ctx.session.hotspotPool ?? '',
      profile: `${OWNER}-${ctx.session.tag}`,
      comment: tag(ctx.session.tag),
      'idle-timeout': `${ctx.session.idleTimeoutMin}m`,
      'keepalive-timeout': `${ctx.session.sessionTimeoutMin}m`,
      disabled: 'false',
    }
    // An empty pool or a profile that does not exist yet is a RouterOS error, and
    // the honest thing is to omit them rather than send an empty string.
    if (!ctx.session.hotspotPool) delete params['address-pool']

    const existing = findOwned(servers, name)
      // Something the operator put on this interface already: update it rather
      // than adding a second server that would fight the first for the port.
      ?? servers.find((r) => r.interface === iface)

    if (existing) {
      const set = await attempt(client, target, '/ip/hotspot/set', {
        ...addressing(existing),
        ...params,
      })
      if (!set.ok) {
        return {
          status: 'failed',
          error: `The HotSpot server on ${iface} could not be updated: ${set.error}`,
          retryable: true,
        }
      }
      updated.push(iface)
      continue
    }

    const add = await attempt(client, target, '/ip/hotspot/add', params)
    if (!add.ok) {
      return {
        status: 'failed',
        error: `A HotSpot server could not be created on ${iface}: ${add.error}`,
        retryable: /timeout|temporarily/i.test(add.error ?? ''),
      }
    }
    created.push(iface)
  }

  return {
    status: 'success',
    detail: {
      interfaces: ifaces,
      created,
      updated,
      // What was already on other interfaces and deliberately left alone.
      untouched: servers.filter((r) => !ifaces.includes(r.interface ?? '')).length,
    },
  }
}

/**
 * PPPOE.
 *
 * Only the selected interfaces, only for the plans that need it. A PPPoE server
 * already serving an interface is reused; a second one on the same interface
 * cannot bind the same MAC range and fails in a way that looks random.
 */
export const pppoeStage: StageFn = async (client, target, ctx) => {
  const ifaces = ctx.session.pppoeInterfaces
  if (ifaces.length === 0) {
    return { status: 'skipped', skipReason: 'No PPPoE interface was selected.' }
  }

  const probe = await attempt(client, target, '/interface/pppoe-server/print')
  if (!probe.ok) {
    return {
      status: 'unsupported',
      skipReason: 'This firmware does not provide PPPoE.',
      detail: { error: probe.error },
    }
  }

  if (!ctx.session.pppLocal || !ctx.session.pppRemote) {
    return {
      status: 'failed',
      error: 'PPPoE was selected but no address pool could be resolved for it. '
        + 'The router reported no usable address range, so there is nowhere to '
        + 'allocate subscriber addresses. No range is ever guessed here: add one '
        + 'in IP > Addresses on the router, or give PPPoE a range in the wizard.',
      retryable: false,
    }
  }

  const created: string[] = []
  const updated: string[] = []

  for (const iface of ifaces) {
    const name = `${OWNER}-${ctx.session.tag}-${iface}`
    const params: Record<string, string> = {
      name,
      service: iface,
      'local-address': ctx.session.pppLocal,
      'remote-address': ctx.session.pppRemote,
      profile: `${OWNER}-${ctx.session.tag}`,
      comment: tag(ctx.session.tag),
      'one-session-per-host': 'yes',
      disabled: 'false',
    }

    const existing = findOwned(probe.rows, name)
      ?? probe.rows.find((r) => r.service === iface)

    if (existing) {
      const set = await attempt(client, target, '/interface/pppoe-server/set', {
        ...addressing(existing),
        ...params,
      })
      if (!set.ok) {
        return {
          status: 'failed',
          error: `The PPPoE server on ${iface} could not be updated: ${set.error}`,
          retryable: true,
        }
      }
      updated.push(iface)
      continue
    }

    const add = await attempt(client, target, '/interface/pppoe-server/add', params)
    if (!add.ok) {
      return {
        status: 'failed',
        error: `A PPPoE server could not be created on ${iface}: ${add.error}`,
        retryable: /timeout|temporarily/i.test(add.error ?? ''),
      }
    }
    created.push(iface)
  }

  return {
    status: 'success',
    detail: { interfaces: ifaces, created, updated },
  }
}

/**
 * FIREWALL_NAT.
 *
 * This stage ADDS and never removes. Not one rule, not one NAT entry, not one
 * address list. The router belongs to the ISP and may be carrying paying
 * customers on a firewall this platform has never seen and does not understand.
 *
 * Every object it creates is tagged, and it checks for its own objects before
 * creating them, so a re-run after a crash does not stack a second copy of the
 * same NAT rule. Nothing an operator or an older NETISP run created is touched,
 * renamed, or reordered.
 *
 * It is also the stage most likely to be tempted into "tidying up". The
 * temptation is exactly the failure mode: a rule the platform cannot explain
 * looks untidy, and deleting it because it looks untidy takes a customer's
 * service offline.
 */
export const firewallNatStage: StageFn = async (client, target, ctx) => {
  const wan = ctx.session.wanInterface
  if (!wan) {
    return {
      status: 'skipped',
      skipReason: 'No WAN interface was selected, so no NAT rule was needed.',
    }
  }

  const nat = await attempt(client, target, '/ip/firewall/nat/print')
  if (!nat.ok) {
    return {
      status: 'failed',
      error: `The firewall could not be read, so nothing can safely be added: ${nat.error}`,
      retryable: true,
    }
  }

  const outIface = `${OWNER}-${ctx.session.tag}-out`
  const created: string[] = []
  let updated = false

  // Match on OUR name, but ALSO on an existing masquerade already bound to this
  // WAN interface.
  //
  // The second case matters: RouterOS evaluates srcnat in order, so adding a
  // second masquerade for an interface that already has one does not "work as
  // well", it creates two NAT rules for the same traffic and the operator has to
  // work out which one is winning. Reusing the existing rule is the only correct
  // behaviour, and it is also why a legacy NETISP NAT rule is adopted rather
  // than shadowed.
  const existing = findOwned(nat.rows, outIface)
    ?? nat.rows.find((row) =>
      row['out-interface'] === wan
      && (row.action ?? '') === 'masquerade')
  if (existing) {
    const set = await attempt(client, target, '/ip/firewall/nat/set', {
      ...addressing(existing),
      'out-interface': wan,
      action: 'masquerade',
      comment: tag(ctx.session.tag),
    })
    if (!set.ok) {
      return {
        status: 'failed',
        error: `The existing NAT rule could not be updated: ${set.error}`,
        retryable: true,
      }
    }
    updated = true
  } else {
    const add = await attempt(client, target, '/ip/firewall/nat/add', {
      name: outIface,
      chain: 'srcnat',
      'out-interface': wan,
      action: 'masquerade',
      comment: tag(ctx.session.tag),
    })
    if (!add.ok) {
      return {
        status: 'failed',
        error: `Source NAT could not be enabled on ${wan}: ${add.error}. `
          + 'Without it subscribers on this router have no internet access, so '
          + 'provisioning stops here.',
        retryable: /timeout|temporarily/i.test(add.error ?? ''),
      }
    }
    created.push(outIface)
  }

  // Drop rules that protect the platform's own management path from being locked
  // out by a router that blocks input by default. Additive: if a rule already
  // accepts the platform, this is skipped rather than duplicated.
  const filter = await attempt(client, target, '/ip/firewall/filter/print')
  const mgmtRule = `${OWNER}-${ctx.session.tag}-mgmt`
  let mgmtAdded = false

  if (filter.ok) {
    const haveMgmt = findOwned(filter.rows, mgmtRule)
    if (!haveMgmt) {
      // Only the management interfaces the ISP nominated. Adding an input accept
      // for the whole internet would be a security hole, so this is deliberately
      // narrow and is skipped entirely when no management port was chosen.
      const mgmtIfaces = ctx.session.managementInterfaces
      if (mgmtIfaces.length > 0) {
        const add = await attempt(client, target, '/ip/firewall/filter/add', {
          name: mgmtRule,
          chain: 'input',
          action: 'accept',
          'in-interface': mgmtIfaces.join(','),
          comment: tag(ctx.session.tag),
        })
        if (add.ok) mgmtAdded = true
        // A failure here is NOT fatal. The router is already reachable - this
        // stage is running through it - and refusing to continue here would
        // strand a router that is otherwise perfectly fine.
      }
    }
  }

  return {
    status: 'success',
    detail: {
      wan,
      nat_created: created,
      nat_updated: updated,
      mgmt_rule_added: mgmtAdded,
      // Evidence that nothing was removed, for the operator to check later.
      nat_rules_preserved: nat.rows.length,
      filter_rules_preserved: filter.ok ? filter.rows.length : null,
    },
  }
}

/**
 * One plan, turned into the rate limit the router needs.
 *
 * Throws when the speed cannot be read. That is the whole point: a metered
 * package with no rate limit is unlimited bandwidth, and the ISP finds out from
 * their invoice. Failing the stage stops the router going online and names the
 * package to fix.
 */
export function profileRateLimit(plan: StagePlan): string {
  const down = parseSpeedMbps(plan.speed_down)
  const up = parseSpeedMbps(plan.speed_up)
  if (down === null || up === null) {
    throw new Error(
      `Package "${plan.name}" has an unreadable `
      + `${down === null ? 'download' : 'upload'} speed `
      + `(speed_down="${plan.speed_down}", speed_up="${plan.speed_up}"). `
      + 'RouterOS cannot be given a rate limit from it, and applying no limit would '
      + 'sell a metered package as unlimited. Fix the package and re-run.',
    )
  }
  return rateLimit(down, up)
}

/**
 * PACKAGE_SYNC.
 *
 * Every number here comes from the database row the ISP edited. There is no
 * table of "10 Mbps -> 10M/10M" anywhere in this file: raise a package from
 * 3 Mbps to 20 Mbps in the dashboard and the next sync writes 20M, with no code
 * change and no redeploy.
 *
 * Prices never appear. A router has no use for a price, and writing one into a
 * device that survives in backups and exports would leak the ISP's commercial
 * terms to anyone who can reach the router.
 *
 * All-or-nothing: a plan with an unreadable speed fails the stage before
 * anything is written, because four good profiles plus one failure leaves a
 * router matching no package the ISP actually sells.
 */
export const packageSyncStage: StageFn = async (client, target, ctx) => {
  // Active plans only. A hidden-from-the-portal package is still included: it is
  // still sold at the counter and still renewed. A DEACTIVATED package is not
  // provisioned - but an already-created profile is left in place rather than
  // deleted, because subscribers may still be on it.
  const active = ctx.plans.filter((p) => p.is_active)
  if (active.length === 0) {
    return {
      status: 'success',
      detail: { plans: 0, note: 'The ISP has no active packages yet.' },
    }
  }

  // Build and validate EVERY profile before touching the router.
  const wanted = active.map((p) => {
    const name = safeName(p.name)
    if (!name) {
      throw new Error(`Package "${p.name}" has no usable RouterOS object name.`)
    }
    return { plan: p, name, limit: profileRateLimit(p) }
  })

  const shared = `${OWNER}-${ctx.session.tag}`
  const hotspotProfiles = await attempt(client, target, '/ip/hotspot/user/profile/print')
  if (!hotspotProfiles.ok) {
    return {
      status: 'unsupported',
      skipReason: 'This firmware has no HotSpot user profiles.',
      detail: { error: hotspotProfiles.error },
    }
  }

  const created: string[] = []
  const updated: string[] = []

  for (const { plan, name, limit } of wanted) {
    const params: Record<string, string> = {
      name,
      'rate-limit': limit,
      'shared-users': String(Math.max(1, plan.shared_users || 1)),
      comment: tag(ctx.session.tag),
    }
    const existing = findOwned(hotspotProfiles.rows, name)
    if (existing) {
      const set = await attempt(client, target, '/ip/hotspot/user/profile/set', {
        ...addressing(existing),
        ...params,
      })
      if (!set.ok) {
        return {
          status: 'failed',
          error: `The profile for "${plan.name}" could not be updated: ${set.error}`,
          retryable: true,
        }
      }
      updated.push(name)
    } else {
      const add = await attempt(client, target, '/ip/hotspot/user/profile/add', params)
      if (!add.ok) {
        return {
          status: 'failed',
          error: `The profile for "${plan.name}" could not be created: ${add.error}`,
          retryable: /timeout|temporarily/i.test(add.error ?? ''),
        }
      }
      created.push(name)
    }
  }

  // PPP profiles, only for the plans that need one, only when a pool exists.
  let pppCreated: string[] = []
  if (ctx.session.pppLocal && ctx.session.pppRemote) {
    const pppProfiles = await attempt(client, target, '/ppp/profile/print')
    if (pppProfiles.ok) {
      for (const { plan, name } of wanted) {
        if (plan.kind !== 'pppoe' && plan.kind !== 'fiber') continue
        const params: Record<string, string> = {
          name,
          'local-address': ctx.session.pppLocal!,
          'remote-address': ctx.session.pppRemote!,
          comment: tag(ctx.session.tag),
        }
        const existing = findOwned(pppProfiles.rows, name)
        const res = existing
          ? await attempt(client, target, '/ppp/profile/set', {
            ...addressing(existing), ...params,
          })
          : await attempt(client, target, '/ppp/profile/add', params)
        if (!res.ok) {
          return {
            status: 'failed',
            error: `The PPP profile for "${plan.name}" could not be applied: ${res.error}`,
            retryable: true,
          }
        }
        if (!existing) pppCreated.push(name)
      }
    }
  }

  return {
    status: 'success',
    detail: {
      plans: wanted.length,
      hotspot_created: created,
      hotspot_updated: updated,
      ppp_created: pppCreated,
      shared_profile: shared,
      // Proof that a price never reached the device.
      prices_written: 0,
    },
  }
}

/**
 * CUSTOMER_SYNC.
 *
 * Pushes the ISP's ALREADY-ACTIVE entitlements onto the router. It reads
 * entitlements; it never decides them.
 *
 * WHAT THIS STAGE MUST NEVER DO, and the reason each rule exists:
 *
 *   * alter a payment status       -> billing is the database's job, not the
 *                                     router's. A sync that "helpfully" marked a
 *                                     customer paid would let them use the
 *                                     service and never pay for it.
 *   * rewrite a historical payment -> an invoice is a record of what happened.
 *   * change a payment amount      -> same.
 *   * activate an unsubscribed user-> the router MIRRORS the database. When the
 *                                     two disagree the database is right and
 *                                     this stage is wrong.
 *
 * So the only entitlement field read is `is_active`, and it comes from the
 * entitlement the billing system already granted. Everything this stage writes to
 * the router is reversible and safe to re-run.
 *
 * Idempotent: an account already present is left alone, so re-running does not
 * churn a live session or reset a subscriber's traffic counters.
 */
export const customerSyncStage: StageFn = async (client, target, ctx) => {
  const active = ctx.customers.filter((c) => c.is_active)
  if (active.length === 0) {
    return {
      status: 'success',
      detail: { customers: 0, note: 'No active entitlements to synchronise.' },
    }
  }

  const wantsHotspot = ctx.session.role !== 'pppoe'
  const wantsPppoe = ctx.session.role !== 'hotspot'

  // Which of the two each entitlement belongs on. Taken from the PLAN's service,
  // not from the router's role: a router may run both services, but that does not
  // make every subscriber a subscriber of both.
  const planService = (name: string | null): 'hotspot' | 'pppoe' | 'none' => {
    const plan = ctx.plans.find((p) => p.name === name)
    if (!plan) return 'none'
    if (plan.kind === 'pppoe' || plan.kind === 'fiber') return 'pppoe'
    if (plan.kind === 'hotspot') return 'hotspot'
    return 'none'
  }

  let created = 0
  let skipped = 0
  const failures: string[] = []

  if (wantsHotspot) {
    const probe = await attempt(client, target, '/ip/hotspot/user/print')
    if (!probe.ok) {
      return {
        status: 'unsupported',
        skipReason: 'This firmware has no HotSpot users.',
        detail: { error: probe.error },
      }
    }
    const existing = new Map(probe.rows.map((r) => [r.name, r]))

    for (const c of active) {
      const service = c.service === 'none' ? planService(c.plan_name) : c.service
      if (service !== 'hotspot' && service !== 'both') { skipped += 1; continue }
      // Already there, or no credential to create it with.
      if (existing.has(c.username) || !c.password_plain) { skipped += 1; continue }
      const params: Record<string, string> = {
        name: c.username,
        password: c.password_plain,
        comment: tag(ctx.session.tag),
      }
      if (c.plan_name) params['profile'] = c.plan_name
      const add = await attempt(client, target, '/ip/hotspot/user/add', params)
      if (add.ok) created += 1
      else failures.push(`${c.username}: ${add.error}`)
    }
  }

  if (wantsPppoe) {
    const probe = await attempt(client, target, '/ppp/secret/print')
    if (probe.ok) {
      const existing = new Map(probe.rows.map((r) => [r.name, r]))
      for (const c of active) {
        const service = c.service === 'none' ? planService(c.plan_name) : c.service
        if (service !== 'pppoe' && service !== 'both') { skipped += 1; continue }
        if (existing.has(c.username) || !c.password_plain) { skipped += 1; continue }
        const params: Record<string, string> = {
          name: c.username,
          password: c.password_plain,
          comment: tag(ctx.session.tag),
          service: `${OWNER}-${ctx.session.tag}-pppoe`,
        }
        if (c.plan_name) params['profile'] = c.plan_name
        const add = await attempt(client, target, '/ppp/secret/add', params)
        if (add.ok) created += 1
        else failures.push(`${c.username}: ${add.error}`)
      }
    }
  }

  if (failures.length > 0) {
    return {
      status: 'failed',
      // Usernames only, never passwords: this message is rendered in a browser
      // and must not be a place a credential can leak.
      error: `${failures.length} account(s) could not be applied: `
        + `${failures.slice(0, 5).join('; ')}. No payment or billing record was changed.`,
      retryable: true,
      detail: { created, skipped, failed: failures.length },
    }
  }

  return {
    status: 'success',
    detail: {
      entitled: active.length,
      created,
      already_present: skipped,
      // Stated so an operator can see this stage is a mirror, not a decision.
      payments_touched: 0,
      entitlements_created_here: 0,
    },
  }
}

/**
 * HEARTBEAT.
 *
 * The worker already polls this router every 30-120 seconds over a persistent
 * socket, so a scheduler on the router is not how the platform learns it is
 * alive. What this stage installs is the router's OWN way of reporting, which
 * is what matters when the worker cannot reach the router but the router can
 * reach the internet.
 *
 * Created only when absent. Two heartbeat schedulers on one device is a support
 * call, and a re-run after a crash must not create the second one.
 */
export const heartbeatStage: StageFn = async (client, target, ctx) => {
  const name = `${OWNER}-heartbeat-${ctx.session.tag}`

  const sched = await attempt(client, target, '/system/scheduler/print')
  if (!sched.ok) {
    return {
      status: 'unsupported',
      skipReason: 'This firmware has no scheduler; the platform polls the router instead.',
      detail: { error: sched.error },
    }
  }

  if (findOwned(sched.rows, name)) {
    return {
      status: 'success',
      detail: { scheduler: name, already_present: true },
    }
  }

  const add = await attempt(client, target, '/system/scheduler/add', {
    name,
    comment: tag(ctx.session.tag),
    // Generous by default: frequent polling exhausts a rural uplink and a 32 MB
    // device at the same time.
    interval: '10m',
    'on-event': `/log/info message="ISPFlow heartbeat ${ctx.session.tag}"`,
    policy: 'read,write,policy,test',
  })
  if (!add.ok) {
    return {
      status: 'failed',
      error: `The heartbeat scheduler could not be created: ${add.error}. The `
        + 'platform can still manage this router through the worker, but the router '
        + 'will not report in on its own.',
      retryable: /timeout|temporarily/i.test(add.error ?? ''),
    }
  }

  return { status: 'success', detail: { scheduler: name, created: true } }
}

/**
 * SYNC_SCRIPTS.
 *
 * Marks the router so later sessions can tell what is ours. Every object here is
 * tagged and created only when absent, and nothing is replaced.
 *
 * This is the stage that keeps a legacy NETISP router recognisable: the mark is
 * ADDITIVE. An existing NETISP comment is never rewritten to say ISPFlow, because
 * rewriting it would break an ISP's own runbook that greps for NETISP, and would
 * make the old platform believe it no longer owns anything.
 */
export const syncScriptsStage: StageFn = async (client, target, ctx) => {
  const identity = await attempt(client, target, '/system/identity/print')
  if (!identity.ok) {
    return {
      status: 'failed',
      error: `The router's identity could not be read: ${identity.error}`,
      retryable: true,
    }
  }

  const existingName = identity.rows[0]?.name ?? ''
  const marker = `[${OWNER}:${ctx.session.tag}]`
  const legacy = existingName.includes(`${LEGACY_OWNER}:`)

  // Already carrying a marker, either ours or the legacy one. Left exactly as it
  // is: this stage records ownership, it does not rebrand a router.
  if (existingName.includes(marker) || legacy) {
    return {
      status: 'success',
      detail: {
        identity: existingName,
        already_marked: true,
        legacy_netisp: legacy,
        // Noted so an operator can see the old tag is recognised, not renamed.
        preserved_legacy_tag: legacy,
      },
    }
  }

  const set = await attempt(client, target, '/system/identity/set', {
    name: `${existingName} ${marker}`.trim(),
  })
  if (!set.ok) {
    return {
      status: 'failed',
      error: `The router's identity could not be marked as managed: ${set.error}`,
      retryable: true,
    }
  }

  return {
    status: 'success',
    detail: { marked: true, legacy_netisp: legacy },
  }
}

/**
 * VERIFICATION.
 *
 * Read-only. It re-reads the router and decides what is TRUE, rather than
 * trusting that the earlier stages which reported success actually did their
 * work. "The stage said it worked" and "the router is configured" are different
 * claims, and only the second one matters before a router serves customers.
 *
 * It writes nothing. A verification stage that could change something is not a
 * verification stage.
 */
export const verificationStage: StageFn = async (client, target, ctx) => {
  const problems: string[] = []
  const evidence: Record<string, unknown> = {}

  // The backup the run depends on must actually be on the device.
  const files = await attempt(client, target, '/file/print')
  if (!files.ok) {
    problems.push('The router would not list its files, so the backup cannot be '
      + `confirmed: ${files.error}`)
  } else {
    const backup = files.rows.find((r) => (r.name ?? '')
      .startsWith(`ispflow-backup-${ctx.session.tag}`))
    if (!backup) {
      problems.push('The backup this run depends on is not on the router. '
        + 'Provisioning is not verified.')
    } else {
      evidence.backup = { filename: backup.name, size: backup.size ?? null }
    }
  }

  // Management must still work. We are talking over it, so this is a formality -
  // but it catches a router whose service was disabled by an earlier stage.
  const services = await attempt(client, target, '/ip/service/print')
  if (services.ok) {
    const api = services.rows.find((r) => r.name === 'api')
    if (!api || truthy(api.disabled)) {
      problems.push('The RouterOS API is not enabled, so this router cannot be managed.')
    } else {
      evidence.api_port = api.port ?? null
    }
  }

  // Whatever the ISP selected must actually exist now.
  if (ctx.session.hotspotInterfaces.length > 0) {
    const hs = await attempt(client, target, '/ip/hotspot/print')
    if (!hs.ok) {
      problems.push(`HotSpot was selected but this router has none: ${hs.error}`)
    } else {
      const missing = ctx.session.hotspotInterfaces
        .filter((i) => !hs.rows.some((r) => r.interface === i))
      if (missing.length > 0) {
        problems.push(`No HotSpot server is running on ${missing.join(', ')}.`)
      } else {
        evidence.hotspot = hs.rows.length
      }
    }
  }

  if (ctx.session.pppoeInterfaces.length > 0) {
    const ppp = await attempt(client, target, '/interface/pppoe-server/print')
    if (!ppp.ok) {
      problems.push(`PPPoE was selected but this router has none: ${ppp.error}`)
    } else {
      const missing = ctx.session.pppoeInterfaces
        .filter((i) => !ppp.rows.some((r) => r.service === i))
      if (missing.length > 0) {
        problems.push(`No PPPoE server is running on ${missing.join(', ')}.`)
      } else {
        evidence.pppoe = ppp.rows.length
      }
    }
  }

  // A required tunnel must EXIST, not merely be "not unsupported".
  if (ctx.session.tunnelRequired) {
    const wg = await attempt(client, target, '/interface/wireguard/print')
    const named = wg.ok ? findOwned(wg.rows, `${OWNER}-${ctx.session.tag}`) : null
    if (!named) {
      problems.push('A WireGuard tunnel was required for this router, but no such '
        + 'tunnel exists on it. It cannot be managed and is not verified.')
    } else {
      evidence.wireguard = named.name
    }
  }

  // RADIUS, when the ISP relies on it, must be present and enabled.
  if (ctx.session.radiusEnabled && ctx.session.radiusServer) {
    const radius = await attempt(client, target, '/radius/print')
    const named = radius.ok ? findOwned(radius.rows, `${OWNER}-${ctx.session.tag}`) : null
    if (!named) {
      problems.push(`RADIUS is in use for this ISP but ${ctx.session.radiusServer} is `
        + 'not configured on the router, so subscribers cannot authenticate.')
    } else if (truthy(named.disabled)) {
      problems.push('The RADIUS server is configured but disabled on the router.')
    } else {
      // Whether a secret is set, never the secret itself.
      evidence.radius = { address: named.address ?? null, secret_set: !!named.secret }
    }
  }

  if (problems.length > 0) {
    return { status: 'failed', error: problems.join(' '), retryable: true, detail: evidence }
  }

  return {
    status: 'success',
    detail: {
      verified: true,
      ...evidence,
      entitlements_present: ctx.customers.length,
    },
  }
}

// =============================================================================
//  The registry.
//
//  One map from stage name to implementation. The ORDER is deliberately NOT
//  declared here - the database owns it (provisioning_stage_order()) and the test
//  suite asserts this map matches. Two sources of truth for "what comes next" is
//  exactly how a stage ends up running before the one it depends on.
// =============================================================================

export const STAGE_IMPLEMENTATIONS: Record<string, StageFn> = {
  discovery: discoveryStage,
  backup: backupStage,
  connectivity: connectivityStage,
  secure_tunnel: secureTunnelStage,
  radius: radiusStage,
  hotspot: hotspotStage,
  pppoe: pppoeStage,
  firewall_nat: firewallNatStage,
  sync_scripts: syncScriptsStage,
  heartbeat: heartbeatStage,
  package_sync: packageSyncStage,
  customer_sync: customerSyncStage,
  verification: verificationStage,
}

/** The stage names this worker knows how to run, in catalogue order. */
export const WORKER_STAGE_NAMES = Object.keys(STAGE_IMPLEMENTATIONS)

/**
 * Runs one stage.
 *
 * A stage that THROWS is a failed stage, not a crashed worker. package_sync in
 * particular throws by design when a package speed cannot be read, and that has
 * to surface as a clear, named, actionable failure rather than a stack trace in
 * the job log with the stage left stuck in 'running' forever.
 */
export async function runStage(
  name: string,
  client: RouterClient,
  target: RouterTarget,
  ctx: StageContext,
): Promise<StageOutcome> {
  const fn = STAGE_IMPLEMENTATIONS[name]
  if (!fn) {
    return {
      status: 'failed',
      error: `This worker has no implementation for the "${name}" stage. `
        + `It knows: ${WORKER_STAGE_NAMES.join(', ')}.`,
      retryable: false,
    }
  }
  try {
    return await fn(client, target, ctx)
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      // A thrown error is usually a data problem the operator must fix, so
      // retrying it unchanged would only repeat it.
      retryable: false,
    }
  }
}

// APPEND_HERE
