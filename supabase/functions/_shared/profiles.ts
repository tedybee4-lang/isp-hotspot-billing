// =============================================================================
//  Package to network profile generation.
//
//  An ISP's packages live in `plans`. What a router needs is different-shaped:
//  a HotSpot user profile with a rate limit, a PPP profile with local and
//  remote addresses, and a RADIUS reply that carries the speed. This turns the
//  first into the second.
//
//  THE ONE RULE: every number here comes from the database row.
//
//  There is no table of "10 Mbps -> 10M/10M" in this file or anywhere else.
//  Speeds are parsed from the ISP's own speed_down/speed_up text at the moment
//  the script is generated, so when the ISP edits a package from 3 Mbps to
//  20 Mbps in their dashboard, the next sync writes 20 Mbps without a code
//  change, a redeploy, or an intervention. Hardcoding the ladder is how a
//  platform ends up selling 5 Mbps and delivering 3.
//
//  PRICES NEVER APPEAR HERE. A router has no use for a price, and writing one
//  into a device that survives in backups and exports would leak the ISP's
//  commercial terms into a file anyone with the router can read. The price
//  lives in the billing database and is applied at payment time.
// =============================================================================

/** A plan row, as the provisioning path sees it. */
export interface PlanRow {
  id: string
  name: string
  kind: 'hotspot' | 'pppoe' | 'fiber'
  price: number | string
  speed_down: string
  speed_up: string
  duration_label: string
  duration_hours: number
  data_limit?: string | null
  fup?: string | null
  shared_users?: number
  is_active?: boolean
  show_on_portal?: boolean
}

export interface ProfilePlan {
  /** Name of the object to create on the router. */
  objectName: string
  /** HotSpot rate limit, RouterOS syntax. */
  rateLimit: string
  downloadKbps: number | null
  uploadKbps: number | null
  /** PPP profile addressing, used only for pppoe/fiber plans. */
  localAddress: string | null
  remoteAddress: string | null
  /** Whether this plan needs a PPP profile at all. */
  needsPpp: boolean
  /** Data limit and FUP, both free-text in this schema. */
  dataLimit: string | null
  fup: string | null
}

/**
 * RouterOS writes speeds as `10M`, `512k`, `1G`. The stored text is whatever
 * the ISP typed ("10 Mbps", "10Mbps", "10 Mb/s"), so it has to be parsed into a
 * number rather than pattern-matched against a fixed list.
 *
 * Returns null when the text carries no number at all. A null is not silently
 * replaced with a default: an unparseable speed must surface, because the
 * alternative is provisioning a profile with no rate limit, which on a real
 * router means unlimited bandwidth sold as a metered package.
 */
export function parseSpeedMbps(text: string | null | undefined): number | null {
  if (!text) return null
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(k|m|g)?/i.exec(text.trim())
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (m[2] ?? 'm').toLowerCase()
  // Normalised to Mbps internally; converted to kbit at the edge.
  if (unit === 'k') return value / 1000
  if (unit === 'g') return value * 1000
  return value
}

/**
 * RouterOS rate-limit syntax from a megabit figure, e.g. `20M/10M`.
 *
 * `formatMbps` already returns a suffixed RouterOS figure (`20M`, `500k`, `1G`),
 * so nothing is appended here. Appending a further `M` produced `20MM`, which
 * RouterOS rejects - and a rejected rate-limit is a stage that fails on the
 * router rather than a package that is quietly wrong.
 */
export function toRateLimit(downMbps: number | null, upMbps: number | null): string {
  const d = downMbps === null ? 'unlimited' : formatMbps(downMbps)
  const u = upMbps === null ? 'unlimited' : formatMbps(upMbps)
  // A symmetric package is written as `10M` rather than `10M/10M`, because that
  // is what RouterOS itself writes and an ISP reading the config expects it.
  return d === u ? d : `${d}/${u}`
}

function formatMbps(mbps: number): string {
  // RouterOS writes a kbit figure as `k`, or as M/G above a thousand. Converting
  // to G is done at 1_000_000 kbit, NOT at 100_000: treating the threshold as
  // 100_000 kbit and dividing by 100_000 turns 100 Mbps into "1G" and then
  // formatMbps(1000) into "10G", selling a 1 Gbps package as 10 Gbps.
  const kbit = Math.round(mbps * 1000)
  if (kbit >= 1_000_000) return `${Math.round(kbit / 1_000_000)}G`
  if (kbit >= 1000) return `${Math.round(kbit / 1000)}M`
  return `${kbit}k`
}

/**
 * The name a plan's objects get on the router.
 *
 * A plan name is free text typed by the ISP, and it becomes a RouterOS object
 * name that lands in an import file, an export, and a support ticket. Newlines,
 * quotes, semicolons and the RouterOS comment delimiters all change the meaning
 * of the generated script, and a name that changes the meaning of the script is
 * a way to inject configuration onto a router. So the name is reduced to
 * characters that cannot do that, rather than trusted.
 *
 * Sanitising is silent and lossless in practice ("Home 5M" -> "Home_5M") because
 * it is applied at generation time and the result is what gets stored as the
 * object name; the original name is untouched in the database.
 *
 * Characters dropped from a plan name are listed one by one below rather than
 * as a regular expression character class on purpose: the class would itself
 * need the quote, the backslash and the comment delimiters escaped, which is
 * exactly the kind of dense escaping that is easy to get subtly wrong and hard
 * to review. A set says plainly which characters are dangerous.
 *
 * `*` and `/` matter together: they open and close a RouterOS comment. The rest
 * terminate a statement, quote a value, or interpolate one.
 */
const UNSAFE_IN_ROUTEROS = new Set<string>([
  "*",
  "/",
  ";",
  "$",
  "\"",
  "\u0027",
  "\u0060",
  "{",
  "}",
  "\\",
])

export function sanitizeObjectName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f]/g, ' ')     // control chars, incl. newline and tab
    .split('')
    .filter((ch) => !UNSAFE_IN_ROUTEROS.has(ch))
    .join('')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return cleaned || 'plan'
}

/**
 * Raised when a plan cannot be turned into a router profile.
 *
 * This is a thrown error on purpose. The alternative - falling back to an
 * unlimited rate limit - provisions a metered package with no rate limit at
 * all, which means every customer on that package gets the full uplink and the
 * ISP discovers it from the invoice. Failing the stage stops the router going
 * online and tells the operator exactly which package to fix.
 */
export class ProfileSpeedError extends Error {
  readonly planId: string
  readonly planName: string
  constructor(plan: { id: string; name: string }, message: string) {
    super(message)
    this.name = 'ProfileSpeedError'
    this.planId = plan.id
    this.planName = plan.name
  }
}

/**
 * The same as `planProfiles`, but refuses to produce a profile it cannot make
 * sense of.
 *
 * This is what the provisioning path calls. `planProfiles` stays lenient for the
 * preview and reporting paths, where showing a partial result is better than
 * throwing, but nothing that WRITES to a router goes through it.
 */
export function planProfilesStrict(
  plan: PlanRow,
  pool?: { local: string; remote: string } | null,
): ProfilePlan {
  const missing: string[] = []
  if (parseSpeedMbps(plan.speed_down) === null) missing.push('download speed')
  if (parseSpeedMbps(plan.speed_up) === null) missing.push('upload speed')

  if (missing.length > 0) {
    throw new ProfileSpeedError(
      plan,
      `Package "${plan.name}" has an unreadable ${missing.join(' and ')} ` +
        `(speed_down="${plan.speed_down ?? ''}", speed_up="${plan.speed_up ?? ''}"). ` +
        'RouterOS cannot be given a rate limit from it, and applying no limit ' +
        'would sell a metered package as unlimited. Fix the package and re-run.',
    )
  }

  const profile = planProfiles(plan, pool)
  if (profile.needsPpp && (!profile.localAddress || !profile.remoteAddress)) {
    throw new ProfileSpeedError(
      plan,
      `Package "${plan.name}" is a ${plan.kind} package and needs an address pool, ` +
        'but none is available on this router. Assign an address range to PPPoE ' +
        'before provisioning.',
    )
  }
  return profile
}

/**
 * Every profile for a set of plans, or nothing at all.
 *
 * All-or-nothing on purpose: writing the four good profiles and then failing on
 * the fifth leaves a router in a state that matches no plan the ISP sold.
 */
export function planProfilesStrictAll(
  plans: PlanRow[],
  pool?: { local: string; remote: string } | null,
): ProfilePlan[] {
  return plansToSync(plans).map((p) => planProfilesStrict(p, pool))
}

/**
 * Turns one plan into the profile objects it needs on the router.
 *
 * `pool` is the address pool the plan draws from, resolved from DISCOVERY so an
 * existing pool is reused rather than duplicated. It is only applied to plans
 * that actually need addressing (PPPoE and fiber); a HotSpot plan gets its
 * address from the HotSpot server, not from a PPP profile.
 */
export function planProfiles(plan: PlanRow, pool?: { local: string; remote: string } | null): ProfilePlan {
  const down = parseSpeedMbps(plan.speed_down)
  const up = parseSpeedMbps(plan.speed_up)
  const needsPpp = plan.kind === 'pppoe' || plan.kind === 'fiber'

  return {
    // Sanitised, not trusted: this string is written into a RouterOS import.
    objectName: sanitizeObjectName(plan.name),
    rateLimit: toRateLimit(down, up),
    downloadKbps: down === null ? null : Math.round(down * 1000),
    uploadKbps: up === null ? null : Math.round(up * 1000),
    localAddress: needsPpp ? pool?.local ?? null : null,
    remoteAddress: needsPpp ? pool?.remote ?? null : null,
    needsPpp,
    dataLimit: plan.data_limit?.trim() || null,
    fup: plan.fup?.trim() || null,
  }
}

/**
 * The plans that should reach a router.
 *
 * Filtering happens HERE, from the database rows, and deliberately does not
 * consider `show_on_portal`. A package hidden from the storefront is still a
 * real product for renewing customers and must still exist on the router;
 * a package the ISP has deactivated is not sellable and is not provisioned.
 * Coupling the two would let a marketing change silently break renewals.
 */
export function plansToSync(plans: PlanRow[]): PlanRow[] {
  return plans.filter((p) => p.is_active !== false)
}

/** Which service kinds a set of plans needs, so unused stages can be skipped. */
export function servicesNeeded(plans: PlanRow[]): { hotspot: boolean; pppoe: boolean } {
  return {
    hotspot: plans.some((p) => p.kind === 'hotspot'),
    pppoe: plans.some((p) => p.kind === 'pppoe' || p.kind === 'fiber'),
  }
}