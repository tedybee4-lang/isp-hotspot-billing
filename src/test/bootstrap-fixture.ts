// No `vitest` import here on purpose: gen-bootstrap.ts runs this through
// vite-node to write a golden fixture, and importing vitest outside a vitest
// run throws.
import { buildAccessScript } from '../../supabase/functions/_shared/capabilities.ts'
import { buildDiscoveryScript } from '../../supabase/functions/_shared/discovery.ts'
import { buildCompatibility, parseVersion } from '../../supabase/functions/_shared/compat.ts'
import { validateRouterOsScript } from './routeros-validate'

export const CLAIM = 'https://demo.supabase.co/functions/v1/router-provision'
const REPORT = `${CLAIM}/report`
export const TOKEN = 'd'.repeat(48)
const TAG = 'abcd1234'

/**
 * The complete bootstrap exactly as router-provision returns it: access script,
 * claim trailer, discovery survey. The trailer is inline here because the
 * handler assembles it; it is asserted here so the same file is validated.
 */
export function bootstrap(
  rawVersion: string | null,
  arch: string | null,
): string {
  const profile = buildCompatibility(rawVersion, arch, null)
  const parsed = parseVersion(rawVersion ?? '')
  const access = buildAccessScript({ tag: TAG, profile, vpn: null })
  const trailer = [
    '',
    ':local ispFlowClaimName [/system identity get name]',
    ':local ispFlowClaimVer [/system resource get version]',
    ':local ispFlowClaimBoard [/system resource get board-name]',
    ':put ("ISPFlow: registered as " . $ispFlowClaimName);',
    ':put ("ISPFlow: RouterOS " . $ispFlowClaimVer . " on " . $ispFlowClaimBoard);',
    profile.rest
      ? ':put "ISPFlow: HTTPS management is available on port 8080.";'
      : profile.versionKnown
        ? ':put "ISPFlow: this RouterOS version has no REST; the panel will use the API.";'
        : ':put "ISPFlow: RouterOS version not reported; the panel will use the API.";',
  ].join('\n')
  const discovery = buildDiscoveryScript({
    reportUrl: REPORT,
    token: TOKEN,
    // `major` is nullable on purpose: an unidentified router must reach the
    // discovery script as unknown, not be quietly rounded down to 6.
    major: parsed?.major ?? null,
    minor: parsed?.minor ?? null,
    architecture: arch,
    tag: TAG,
  })
  return `${access}\n${trailer}\n${discovery}`
}

/** Compact failure message: the rules, not 1700 lines of script. */
export function rules(script: string): string {
  const found = validateRouterOsScript(script)
  return [...new Set(found.map((i) => `${i.rule}@L${i.line}`))].join(', ')
}

/**
 * Device fixtures. Each is a real class of hardware ISPFlow supports, not a
 * contrived combination: the CHR under test, an ARM RouterOS 7 box, a low-memory
 * RouterOS 6 RB941, and the states where the platform genuinely does not know.
 *
 * `capability` is stated, never inferred from a string. UNKNOWN is a first-class
 * value and must never collapse into UNSUPPORTED - telling an operator their
 * router lacks a feature when the platform simply never asked is how a 7.24.4
 * CHR was once told it had no REST and no WireGuard.
 */
export type WireGuardState = 'supported' | 'supported-empty' | 'unsupported' | 'unknown'
export type FeatureState = 'supported' | 'unsupported' | 'unknown'

export interface DeviceFixture {
  name: string
  version: string | null
  major: number | null
  minor: number | null
  architecture: string | null
  board: string | null
  identity: string
  wireguard: WireGuardState
  rest: FeatureState
}

export const DEVICES: Record<string, DeviceFixture> = {
  // The device under test.
  CHR_7_24_4: {
    name: 'CHR / VirtualBox, RouterOS 7.24.4',
    version: '7.24.4',
    major: 7,
    minor: 24,
    architecture: 'x86_64',
    board: 'CHR innotek GmbH VirtualBox',
    identity: 'CHR',
    wireguard: 'supported',
    rest: 'supported',
  },
  // A real ARM RouterOS 7 box.
  ROS7_ARM64: {
    name: 'hAP ax3, RouterOS 7.24.4',
    version: '7.24.4',
    major: 7,
    minor: 24,
    architecture: 'arm64',
    board: 'hAP ax3',
    identity: 'TEST-ROUTER',
    wireguard: 'supported',
    rest: 'supported',
  },
  // Low-memory RouterOS 6. The version string itself contains a space and
  // parentheses, which is why it must never reach a URL.
  ROS6_RB941: {
    name: 'RB941-2nD, RouterOS 6.49.10',
    version: '6.49.10 (long-term)',
    major: 6,
    minor: 49,
    architecture: 'x86_64',
    board: 'RB941-2nD',
    identity: 'LIPANET',
    wireguard: 'unsupported',
    rest: 'unsupported',
  },
  // Never told us anything. Must stay UNKNOWN on both axes.
  UNKNOWN: {
    name: 'router that reported nothing',
    version: null,
    major: null,
    minor: null,
    architecture: null,
    board: null,
    identity: '',
    wireguard: 'unknown',
    rest: 'unknown',
  },
  // Version known, WireGuard menu present but empty.
  WG_SUPPORTED_EMPTY: {
    name: 'RouterOS 7 with no WireGuard interface yet',
    version: '7.24.4',
    major: 7,
    minor: 24,
    architecture: 'arm',
    board: 'RB750Gr3',
    identity: 'EMPTY-WG',
    wireguard: 'supported-empty',
    rest: 'supported',
  },
}

/** Values that must never be able to corrupt a URL. */
export const UNSAFE_VALUES = {
  identity: 'CHR test & ISP #1',
  board: 'CHR innotek GmbH VirtualBox',
  quotes: 'ISP "WEST"',
  backslash: 'TEST\\ROUTER',
  ampersand: 'A&B',
  percent: '100% router',
  slashQueryHash: 'a/b?c#d',
  unicode: 'LÍPÄNET – ṔṔË',
  empty: '',
}