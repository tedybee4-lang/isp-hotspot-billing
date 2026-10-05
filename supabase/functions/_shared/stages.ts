// =============================================================================
//  The provisioning stage machine.
//
//  Until now a session had ONE state column, which could say "configuring" or
//  "failed" and nothing else. That cannot answer the two questions an ISP
//  actually asks after something goes wrong: which step broke, and what do I
//  press next. It also cannot resume, because there is nothing to resume FROM.
//
//  So provisioning is a list of named stages, each with its own status, and the
//  session state becomes a summary of the list rather than the source of truth.
//
//  THREE RULES, and they are the whole design:
//
//   1. STAGES RUN IN ORDER AND NEVER SKIP AHEAD. A stage may only start when
//      every earlier stage is SUCCESS, SKIPPED or UNSUPPORTED. That is what
//      stops "mark the router online" from being reachable while RADIUS is
//      still broken.
//
//   2. A SUCCESS STAGE IS NOT REPEATED. Before a stage runs it inspects the
//      router; if the thing it would create already exists and is correct, the
//      stage reports SKIPPED with the reason "already correct". Re-running a
//      whole session therefore repairs rather than duplicates - which is the
//      only way re-provisioning can be safe on a router that is already live.
//
//   3. UNSUPPORTED IS NOT FAILED. A RouterOS 6 box has no WireGuard. That stage
//      is UNSUPPORTED, provisioning continues, and the router still goes
//      online. Conflating the two is how a platform ends up reporting every
//      cheap access point as broken.
// =============================================================================

/**
 * The stages, in the order they run.
 *
 * `required` marks the ones that must reach SUCCESS or SKIPPED before a router
 * can be marked online. Backup and verification are required: skipping the
 * backup means configuring a production router with no way back, and skipping
 * verification means claiming success without evidence.
 *
 * `optional` stages may be UNSUPPORTED. WireGuard is optional because a
 * RouterOS 6 device cannot have it, but a router that cannot be reached at all
 * is a different problem and fails connectivity instead.
 */
export interface StageSpec {
  stage: string
  label: string
  required: boolean
}

export const STAGES: StageSpec[] = [
  { stage: 'discovery',       label: 'Discover router',          required: true },
  { stage: 'backup',          label: 'Back up configuration',     required: true },
  { stage: 'connectivity',    label: 'Verify management path',    required: true },
  { stage: 'secure_tunnel',   label: 'Secure tunnel (WireGuard)', required: false },
  { stage: 'radius',          label: 'RADIUS servers',            required: true },
  { stage: 'hotspot',         label: 'HotSpot',                   required: false },
  { stage: 'pppoe',           label: 'PPPoE',                     required: false },
  { stage: 'firewall_nat',    label: 'Firewall and NAT',          required: true },
  { stage: 'sync_scripts',    label: 'Sync scripts',              required: true },
  { stage: 'heartbeat',       label: 'Heartbeat',                 required: true },
  { stage: 'package_sync',    label: 'Package profiles',          required: true },
  { stage: 'customer_sync',   label: 'Customer accounts',         required: false },
  { stage: 'verification',    label: 'Verify router',             required: true },
]

export const STAGE_NAMES = STAGES.map((s) => s.stage)

/** Every status a stage row may hold. */
export type StageStatus =
  | 'pending'      // not started
  | 'running'      // in flight right now
  | 'success'      // done, and verified done
  | 'failed'       // tried, did not work
  | 'skipped'      // deliberately not run (already correct, not selected)
  | 'unsupported'  // the firmware cannot do it

/** Statuses that let the NEXT stage begin. */
export const SETTLED: StageStatus[] = ['success', 'skipped', 'unsupported']

export const isSettled = (s: StageStatus): boolean => SETTLED.includes(s)

export const stageIndex = (stage: string): number => STAGE_NAMES.indexOf(stage)

export const isRequired = (stage: string): boolean =>
  STAGES.find((s) => s.stage === stage)?.required ?? false

/**
 * Can `stage` start, given everything before it?
 *
 * This is the rule that makes a run ordered and resumable. A stage may run when
 * every earlier stage has settled; the first stage that is still pending,
 * running or failed blocks everything after it.
 */
export function canStart(
  stage: string,
  statuses: Record<string, StageStatus>,
): { ok: boolean; blockedBy?: string } {
  const idx = stageIndex(stage)
  if (idx < 0) return { ok: false, blockedBy: 'unknown stage' }

  for (let i = 0; i < idx; i++) {
    const earlier = STAGE_NAMES[i]
    const state = statuses[earlier] ?? 'pending'
    if (!isSettled(state)) return { ok: false, blockedBy: earlier }
  }
  return { ok: true }
}

/**
 * The stage a resume should run next, or null when everything has settled.
 *
 * Returns the stage NAME. Returning the status would be a trap for the caller:
 * a resume that read "failed" as its next step would go looking for a stage
 * called "failed" and find nothing.
 */
export function nextStage(statuses: Record<string, StageStatus>): string | null {
  for (const name of STAGE_NAMES) {
    if (!isSettled(statuses[name] ?? 'pending')) return name
  }
  return null
}

/**
 * Why the router cannot go online yet, or null when it can.
 *
 * ONLINE is gated on EVIDENCE, never on progress. A queued job, a completed
 * token claim, a generated script and a finished discovery all leave this
 * returning a reason. Only a settled required stage set, with no failed
 * required stage anywhere, passes.
 */
export function onlineBlocker(
  statuses: Record<string, StageStatus>,
  /**
   * Stages the ISP explicitly selected for THIS router.
   *
   * A stage marked `required: false` in the list above is optional by default,
   * not optional always: HotSpot is optional for a PPPoE-only ISP but clearly
   * required for one that just bought a HotSpot router. Without this the gate
   * would ignore a failed HotSpot stage on a router that exists to serve
   * HotSpot, and put it ONLINE with the service the ISP paid for not running.
   */
  selected?: string[],
): { stage: string; reason: string } | null {
  const explicitlyRequired = new Set(selected ?? [])
  for (const { stage, label, required } of STAGES) {
    const state = statuses[stage] ?? 'pending'
    const needed = required || explicitlyRequired.has(stage)
    if (!needed) continue
    if (state === 'failed') {
      return { stage, reason: `${label} failed and is required for this router to come online.` }
    }
    if (!isSettled(state)) {
      return { stage, reason: `${label} has not completed yet (${state}).` }
    }
  }

  // Two stages need MORE than "settled", because for both of them settling
  // without succeeding means the evidence is missing rather than the work done.
  //
  // A verification marked skipped or unsupported has not verified anything, and
  // a backup that was skipped was never taken. Treating either as a pass would
  // let a router go ONLINE on nothing but a completed work list - which is the
  // exact claim this gate exists to prevent.
  if (statuses.verification !== 'success') {
    return {
      stage: 'verification',
      reason: statuses.verification
        ? `Router verification did not succeed (${statuses.verification}), so there is no evidence this router works.`
        : 'Router verification has not run, so there is no evidence this router works.',
    }
  }
  if (statuses.backup !== 'success') {
    return {
      stage: 'backup',
      reason: statuses.backup
        ? `No configuration backup was taken (${statuses.backup}); a live router is not changed without one.`
        : 'No configuration backup was taken; a live router is not changed without one.',
    }
  }

  return null
}

/** A single-line summary for the panel, e.g. "4 of 13 stages complete". */
export function progressOf(statuses: Record<string, StageStatus>): {
  total: number
  settled: number
  percent: number
} {
  const total = STAGE_NAMES.length
  const settled = STAGE_NAMES.filter((n) => isSettled(statuses[n] ?? 'pending')).length
  return { total, settled, percent: total === 0 ? 0 : Math.round((settled / total) * 100) }
}

/**
 * The stage statuses implied by what the ISP asked for and what the box can do.
 *
 * Two stages are settled before anything runs: discovery, because the router
 * has already reported; and any service the ISP did not select, which must not
 * sit at pending forever and hold up everything behind it.
 */
export function initialStatuses(opts: {
  role: 'hotspot' | 'pppoe' | 'both'
  wireguardSupported: boolean
  tunnelRequired: boolean
  discovered?: boolean
}): Record<string, StageStatus> {
  const statuses = Object.fromEntries(
    STAGE_NAMES.map((n) => [n, 'pending' as StageStatus]),
  ) as Record<string, StageStatus>

  if (opts.discovered !== false) statuses.discovery = 'success'

  if (opts.role === 'pppoe') statuses.hotspot = 'skipped'
  if (opts.role === 'hotspot') statuses.pppoe = 'skipped'

  // A box that CAN do WireGuard but was not asked to records SKIPPED: the ISP
  // chose not to, which is not a fault.
  //
  // A box that cannot do it is a different question. When the tunnel is merely
  // optional, UNSUPPORTED is the right answer and provisioning continues. When
  // the tunnel is REQUIRED, UNSUPPORTED is a lie: the ISP asked for a router
  // reachable only through that tunnel, so without it the router cannot be
  // managed, and calling that "unsupported" would report a broken router as a
  // healthy one and let it through the ONLINE gate. That combination FAILS.
  if (!opts.wireguardSupported && opts.tunnelRequired) {
    statuses.secure_tunnel = 'failed'
    return statuses
  }
  statuses.secure_tunnel = !opts.wireguardSupported
    ? 'unsupported'
    : opts.tunnelRequired ? 'pending' : 'skipped'

  return statuses
}