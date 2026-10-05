// =============================================================================
//  RouterOS version + hardware compatibility
//
//  Everything the platform does to a router is gated on what that router can
//  actually do. This is where "what can this device do" is decided.
//
//  The two things that catch people out:
//
//    1. REST arrived in RouterOS 7.1. A 6.x device has no REST service, so any
//       code path that assumes REST works is broken on exactly the cheapest,
//       most common access points an ISP deploys - the RB941-2nD and RB951.
//
//    2. WireGuard arrived in 7.1 as well. On an older box the only way in is
//       the API, which means the API port must be reachable - and on an RB941
//       behind CGNAT it is not, which is a fact the UI must state rather than
//       report as "offline".
//
//  Both are modelled as data here so the decision is testable without a router.
// =============================================================================

export interface RouterOsVersion {
  major: number
  minor: number
  patch: number
  /** e.g. "7.14.3 (stable)". */
  raw: string
  channel: string | null
}

/** Parses "7.14.3 (stable)", "6.49.10 (long-term)" and bare "7.1". */
export function parseVersion(text: string | null | undefined): RouterOsVersion | null {
  if (!text) return null
  const m = /(\d+)\.(\d+)(?:\.(\d+))?(?:\s*\(([^)]+)\))?/.exec(text)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    raw: text,
    channel: m[4] ?? null,
  }
}

export const isAtLeast = (v: RouterOsVersion | null, major: number, minor = 0): boolean =>
  !!v && (v.major > major || (v.major === major && v.minor >= minor))

/** REST arrived in 7.1. Before that the platform must use the API. */
export const supportsRest = (v: RouterOsVersion | null): boolean => isAtLeast(v, 7, 1)

/** WireGuard arrived in 7.1 too. Before that, management must be inbound API. */
export const supportsWireGuard = (v: RouterOsVersion | null): boolean => isAtLeast(v, 7, 1)

/** `/interface/bridge` vlan-filtering needs 6.41 or later. */
export const supportsBridgeVlanFiltering = (v: RouterOsVersion | null): boolean =>
  isAtLeast(v, 6, 41)

/** Containers, used only to decide whether to offer a container profile. */
export const supportsContainers = (v: RouterOsVersion | null): boolean => isAtLeast(v, 7, 4)

/**
 * Hardware classes the platform has to get right.
 *
 * These are not marketing names. `smips` and `mipsbe` are the 32-bit parts
 * where 64-bit assumptions break and memory is tight enough that an expensive
 * poll can starve the router. `chr` is software, so it has no board
 * temperature and no serial number to read.
 */
export type HardwareClass =
  | 'smips'      // RB941-2nD, RB951, RB750 - 32-bit MIPS, 16-64 MB
  | 'mipsbe'
  | 'mipsle'
  | 'mips32'
  | 'arm'
  | 'arm64'
  | 'mips64'     // RB5009, CCR - 64-bit MIPS
  | 'x86'        // x86 RouterOS
  | 'x86_64'     // CHR on a 64-bit host
  | 'unknown'

/**
 * How much RAM a class is expected to have.
 *
 * Used only to decide poll aggressiveness, never to decide capability: a real
 * `/system/resource` read always wins over any assumption made here.
 */
export const EXPECTED_RAM_MB: Record<HardwareClass, number | null> = {
  smips: 32, mipsbe: 64, mipsle: 64, mips32: 64,
  arm: 128, arm64: 512, mips64: 512,
  x86: 256, x86_64: 512,
  unknown: null,
}

/**
 * The RB941-2nD / hAP lite compatibility path, stated explicitly.
 *
 * Registering this device must not fail because it lacks a modern feature. It
 * is a SMIPS part with no REST and no WireGuard, and it is perfectly
 * manageable through the plain API. The only concession the platform makes is
 * poll frequency: it reads less per cycle so it does not starve a 32 MB device.
 */
export const LOW_RESOURCE_CLASSES: HardwareClass[] = ['smips', 'mipsbe', 'mipsle', 'mips32']
export interface CompatibilityProfile {
  hardwareClass: HardwareClass
  isChr: boolean
  rest: boolean
  api: boolean
  apiSsl: boolean
  ssh: boolean
  wireGuard: boolean
  bridgeVlanFiltering: boolean
  containers: boolean
  /**
   * Whether the platform could reach this device inbound at all. A pre-7.1
   * device behind CGNAT cannot, and the UI must say exactly that rather than
   * showing a generic "offline".
   */
  inboundManagementPossible: boolean
  /** Plain-language reason, shown verbatim in the panel. */
  managementNote: string
  /** Features this device cannot have, for the UI to hide. */
  unsupported: string[]
  /**
   * Whether the router actually told us its RouterOS version.
   *
   * THIS IS THE FIELD THAT PREVENTS A FALSE CLAIM. Every feature flag below is
   * derived from the version string, so an UNREPORTED version produces rest=false
   * and wireGuard=false - which, read literally, says "this device has neither".
   * For a RouterOS 7.24.4 CHR whose version simply never arrived, that is a lie
   * the panel repeats and the generated script prints.
   *
   * With this flag, a caller can say "unknown" rather than "unsupported", and
   * must: refusing to send a 6.x-only command is right, but announcing that a
   * modern router lacks a feature it has is not.
   */
  versionKnown: boolean
  /** Suggested heartbeat interval for this class. */
  suggestedHeartbeatSecs: number
}

function classifyArchitecture(architectureText: string | null): HardwareClass {
  const arch = (architectureText ?? '').trim().toLowerCase()
  if (arch.includes('smips')) return 'smips'
  if (arch.includes('mips64') || arch.includes('mips-be-64')) return 'mips64'
  if (arch.includes('x86_64') || arch.includes('x86-64')) return 'x86_64'
  if (arch === 'x86' || arch.includes('i386') || arch.includes('i686')) return 'x86'
  if (arch.includes('mipsbe')) return 'mipsbe'
  if (arch.includes('mipsle')) return 'mipsle'
  if (arch.includes('mips32')) return 'mips32'
  if (arch.includes('arm64') || arch.includes('aarch64')) return 'arm64'
  if (arch.includes('arm')) return 'arm'
  return 'unknown'
}

/**
 * Decides what a given router is capable of, from its version and
 * architecture alone.
 *
 * `licenseLevelText` is the `level` property from `/system/license/print`. It is
 * the only reliable CHR signal: a CHR install reports `level=chr`, and its
 * version string is an ordinary `7.x (stable)` with nothing CHR-shaped in it.
 * When it is not supplied the platform falls back to the board name.
 *
 * The caller must still probe which services are actually enabled; this
 * function only answers "could it, given its version and hardware".
 */
export function buildCompatibility(
  versionText: string | null,
  architectureText: string | null,
  boardNameText: string | null = null,
  licenseLevelText: string | null = null,
): CompatibilityProfile {
  const v = parseVersion(versionText)
  const hardwareClass = classifyArchitecture(architectureText)
  const board = (boardNameText ?? '').trim()

  // CHR is software. Its license level says so outright; the board name is the
  // fallback for installs that do not expose the license menu.
  const isChr = /chr/i.test(licenseLevelText ?? '')
    || /chr/i.test(board)
    || (hardwareClass === 'x86' && !board)

  const rest = supportsRest(v)
  const wireGuard = supportsWireGuard(v)
  const api = true                    // every RouterOS we support has the API
  const apiSsl = isAtLeast(v, 6, 49)  // api-ssl service from 6.49
  const ssh = true                    // exists everywhere; availability is probed

  const unsupported: string[] = []
  // Whether the router TOLD us its version. Derived from the same parse the
  // feature flags use, so the two can never disagree about what was known.
  const versionKnown = v !== null
  if (!rest) unsupported.push('rest')
  if (!wireGuard) unsupported.push('wireguard')
  if (!supportsBridgeVlanFiltering(v)) unsupported.push('bridge-vlan-filtering')
  if (!supportsContainers(v)) unsupported.push('containers')
  if (isChr) unsupported.push('board-temperature', 'serial-number')

  const shortVersion = v?.raw.split(' ')[0] ?? 'unknown'
  let managementNote = ''
  if (!rest && !wireGuard) {
    managementNote = 'RouterOS ' + shortVersion + ' has neither REST nor WireGuard. '
      + 'It is managed over the RouterOS API. If this router sits behind CGNAT the '
      + 'API port cannot be reached from the internet, so it needs a public '
      + 'management address or a port forward before it can be managed.'
  } else if (!rest) {
    managementNote = 'REST is not available on RouterOS ' + shortVersion
      + '; management uses the RouterOS API.'
  }

  const lowResource = LOW_RESOURCE_CLASSES.includes(hardwareClass)
  return {
    hardwareClass,
    isChr,
    rest,
    api,
    apiSsl,
    ssh,
    wireGuard,
    bridgeVlanFiltering: supportsBridgeVlanFiltering(v),
    containers: supportsContainers(v),
    // A pre-7.1 device has no tunnel of its own, so the platform can only
    // reach it inbound. Fine on a public IP, impossible behind CGNAT.
    inboundManagementPossible: true,
    managementNote,
    unsupported,
    // Every feature flag above is derived from the version string. An absent
    // version yields rest=false and wireGuard=false, which is CORRECT for
    // refusing to send the command and WRONG for claiming the device lacks the
    // feature. This flag is what lets a caller tell those two cases apart.
    versionKnown,
    // Low-memory devices get polled less often so a sweep cannot starve them.
    suggestedHeartbeatSecs: lowResource ? 120 : 60,
  }
}

/** Model names the platform has explicit knowledge of, for display only. */
const KNOWN_BOARDS: Array<[RegExp, string]> = [
  [/^RB941|hAP\s*lite/i, 'hAP lite (RB941-2nD)'],
  [/^RB951/i, 'RB951'],
  [/^RB952/i, 'RB952'],
  [/^RB750|^hEX\b/i, 'RB750 / hEX'],
  [/^RB760/i, 'RB760 / hEX S'],
  [/^RB4011/i, 'RB4011'],
  [/^RB5009/i, 'RB5009'],
  [/^CCR/i, 'CCR'],
  [/^CRS/i, 'CRS'],
  [/^CHR/i, 'CHR'],
  [/^hAP\b/i, 'hAP'],
  [/^cAP\b/i, 'cAP'],
  [/^wAP\b/i, 'wAP'],
  [/^mAP\b/i, 'mAP'],
  [/^Audience/i, 'Audience'],
]

/** Best-effort friendly name for a board. Falls back to whatever it reported. */
export function describeBoard(boardName: string | null, architecture: string | null): string {
  const raw = (boardName ?? '').trim()
  for (const [pattern, label] of KNOWN_BOARDS) {
    if (pattern.test(raw)) return label
  }
  if (raw) return raw
  const arch = (architecture ?? '').trim()
  if (arch.includes('smips')) return 'SMIPS device (RouterBOARD)'
  if (arch.includes('x86')) return 'x86 / CHR'
  return arch || 'Unknown device'
}