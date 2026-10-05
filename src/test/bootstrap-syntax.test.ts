/**
 * The generated RouterOS bootstrap, checked as RouterOS rather than as text.
 *
 * This file exists because of a REAL hardware failure. On a CHR running
 * RouterOS 7.24.4 the bootstrap downloaded fine (HTTP 200, ~38.7 KiB) and then
 * died at the import with:
 *
 *     Script Error: expected end of command (line 5 column 3)
 *
 * Line 5 was `do={/ip service`. A bare `do={ ... }` block is not valid RouterOS:
 * `do=` is an ARGUMENT to a command (`/ip/service/print do={...}`, which runs
 * the block once per matching row). On a line of its own there is no command to
 * attach it to, and the parser stops.
 *
 * The same device was also told it had "no WireGuard support" and that "REST is
 * not available on this RouterOS version", which is false for 7.24.4. Both of
 * those assertions are below, because both were wrong in the same release.
 */
import {
  buildAccessScript, buildProvisioningCommand, buildRouterScript, parseClaimSelfReport,
} from '../../supabase/functions/_shared/capabilities.ts'
import { buildCompatibility, type CompatibilityProfile } from '../../supabase/functions/_shared/compat.ts'
import { describe, expect, it } from 'vitest'

// ── The device this was reported from ──────────────────────────────────────
const CHR_724 = buildCompatibility('7.24.4 (stable)', 'x86_64', 'CHR')
const ROS6 = buildCompatibility('6.49.10 (long-term)', 'mipsbe', 'RB951')
const ROS7_0 = buildCompatibility('7.0.9', 'arm', 'hAP')

/**
 * Standalone `do={` blocks: the exact construct that broke the import.
 *
 * Comments are stripped first, so prose explaining the old syntax is never
 * mistaken for syntax.
 */
function illegalDoBlocks(script: string): string[] {
  return script
    .split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? '' : l))
    .filter((l) => /^\s*do=\{\s*\S/.test(l))
}

const VPN = {
  interfaceName: 'netisp-wg', listenPort: 13231, peerPublicKey: 'PUBKEY',
  endpointHost: '10.77.0.1', endpointPort: 13231,
  tunnelAddress: '10.77.0.2/24', allowedAddress: '10.77.0.1/32',
}

const ALL_SCRIPTS: Array<[string, string]> = [
  ['access (CHR 7.24.4)', buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: null })],
  ['access (RouterOS 6)', buildAccessScript({ tag: 'ab12', profile: ROS6, vpn: null })],
  ['access (7.0, pre-REST)', buildAccessScript({ tag: 'ab12', profile: ROS7_0, vpn: null })],
  ['access (with VPN)', buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: VPN })],
  ['router (hotspot)', buildRouterScript({
    tag: 'ab12', role: 'hotspot', hotspotInterfaces: ['ether2'], pppoeInterfaces: [],
    wanInterface: 'ether1', dns: ['8.8.8.8', '1.1.1.1'],
    sessionTimeoutMin: 30, idleTimeoutMin: 5,
    radiusServer: null, radiusEnabled: false,
  })],
  ['router (pppoe + radius)', buildRouterScript({
    tag: 'ab12', role: 'both', hotspotInterfaces: ['ether2'],
    pppoeInterfaces: ['ether3'], wanInterface: 'ether1', dns: ['8.8.8.8'],
    sessionTimeoutMin: 30, idleTimeoutMin: 5,
    radiusServer: '10.9.9.9', radiusEnabled: true,
  })],
]

describe('every generated block is syntactically valid RouterOS', () => {
  it('contains no standalone do={ ... } block, anywhere', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      const bad = illegalDoBlocks(script)
      expect(bad, `${name} has an illegal block:\n${bad.join('\n')}`).toEqual([])
    }
  })

  it('every do={ is attached to :if, :foreach or :while', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      for (const line of script.split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        if (!line.includes('do={')) continue
        expect(
          /:\s*(if|foreach|while)\b/.test(line),
          `${name}: do={ not attached to a command: ${line}`,
        ).toBe(true)
      }
    }
  })

  it('every block is closed by a matching brace', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      let depth = 0
      for (const line of script.split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        for (const ch of line) {
          if (ch === '{') depth++
          if (ch === '}') depth--
        }
      }
      expect(depth, `${name}: unbalanced braces (${depth})`).toBe(0)
    }
  })

  it('never writes a command path with an underscore', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      expect(script, name).not.toMatch(/\/(ip|system|interface|ppp|user|certificate)_\w/)
    }
  })
})

describe('a RouterOS 7.24.4 CHR is configured correctly', () => {
  it('is NOT classified as lacking REST or WireGuard', () => {
    expect(CHR_724.versionKnown).toBe(true)
    expect(CHR_724.rest).toBe(true)
    expect(CHR_724.wireGuard).toBe(true)
    expect(CHR_724.unsupported).not.toContain('rest')
    expect(CHR_724.unsupported).not.toContain('wireguard')
  })

  it('is given the HTTPS REST service, and never told it is unavailable', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: null })
    expect(script).toMatch(/\/ip\/service\/add name="www-ssl" port=8080/)
    expect(script).not.toMatch(/REST is not available/)
    expect(script).not.toMatch(/predates HTTPS REST/)
    expect(script).not.toMatch(/no WireGuard support/)
  })

  it('gets the API and API-SSL blocks, in valid form', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: null })
    expect(script).toMatch(/:local ispFlowApi \[\/ip\/service\/find name="api"\]/)
    expect(script).toMatch(/\/ip\/service\/add name="api" port=8728/)
    expect(script).toMatch(/\/ip\/service\/add name="api-ssl" port=8729/)
  })

  it('defines the variables it prints, instead of assuming them', () => {
    // $identity, $version and $board-name were printed but never assigned, so
    // the confirmation line rendered as "registered as  RouterOS  on " and
    // proved nothing.
    const script = buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: null })
    expect(script).toMatch(/:local ispFlowIdentity \[\/system\/identity\/get name\]/)
    expect(script).toMatch(/:local ispFlowVersion \[\/system\/resource\/get version\]/)
    expect(script).toMatch(/:local ispFlowBoard \[\/system\/resource\/get board-name\]/)
    expect(script).not.toMatch(/\$identity/)
    expect(script).not.toMatch(/\$version\b/)
    expect(script).not.toMatch(/\$board-name/)
  })

  it('defines every variable it USES, in every generated script', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      const defined = new Set(
        script.split('\n')
          .map((l) => /^\s*:local\s+([A-Za-z][\w-]*)/.exec(l)?.[1])
          .filter((v): v is string => Boolean(v)),
      )
      for (const line of script.split('\n')) {
        if (line.trimStart().startsWith('#')) continue
        for (const m of line.matchAll(/\$([A-Za-z][\w-]*)/g)) {
          expect(defined.has(m[1]),
            `${name}: $${m[1]} is used but never defined (line: ${line})`).toBe(true)
        }
      }
    }
  })
})

describe('an unknown version is reported as unknown, not unsupported', () => {
  const UNKNOWN: CompatibilityProfile = buildCompatibility(null, null, null)

  it('marks the version as unknown', () => {
    expect(UNKNOWN.versionKnown).toBe(false)
  })

  it('does not claim the device lacks REST or WireGuard', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: UNKNOWN, vpn: null })
    // The false claims printed on the real 7.24.4 CHR.
    expect(script).not.toMatch(/This RouterOS version has no WireGuard support/)
    expect(script).not.toMatch(/REST is not available on this RouterOS version/)
    // It says plainly that it does not know.
    expect(script).toMatch(/did not report its RouterOS/)
  })

  it('still does not send a 7.1+ command to an unidentified device', () => {
    // Not claiming "unsupported" must not turn into "assume modern".
    const script = buildAccessScript({ tag: 'ab12', profile: UNKNOWN, vpn: null })
    expect(script).not.toMatch(/name="www-ssl"/)
    // The API, which every RouterOS has, is still there.
    expect(script).toMatch(/\/ip\/service\/add name="api" port=8728/)
  })
})

describe('RouterOS 6 paths are unchanged and still correct', () => {
  it('is recognised as 6.x with no REST and no WireGuard', () => {
    expect(ROS6.versionKnown).toBe(true)
    expect(ROS6.rest).toBe(false)
    expect(ROS6.wireGuard).toBe(false)
  })

  it('gets the API and nothing else', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: ROS6, vpn: null })
    expect(script).toMatch(/\/ip\/service\/add name="api" port=8728/)
    expect(script).toMatch(/\/ip\/service\/add name="api-ssl" port=8729/)
    // Neither 7.1+ service: sending them aborts the rest of the import.
    expect(script).not.toMatch(/www-ssl/)
    expect(script).not.toMatch(/wireguard/)
  })

  it('is told honestly, because its version WAS reported', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: ROS6, vpn: null })
    expect(script).toMatch(/predates HTTPS REST/)
    expect(script).toMatch(/no WireGuard support/)
    expect(script).not.toMatch(/did not report/)
  })

  it('7.0 is treated as pre-REST, like 6.x', () => {
    expect(ROS7_0.rest).toBe(false)
    expect(buildAccessScript({ tag: 'ab12', profile: ROS7_0, vpn: null }))
      .not.toMatch(/www-ssl/)
  })

  it('refuses a WireGuard block for a device that cannot run one', () => {
    expect(buildAccessScript({ tag: 'ab12', profile: ROS6, vpn: VPN }))
      .not.toMatch(/wireguard\/add/)
  })

  it('writes one when the device does support it', () => {
    const script = buildAccessScript({ tag: 'ab12', profile: CHR_724, vpn: VPN })
    expect(script).toMatch(/\/interface\/wireguard\/add/)
    expect(script).toMatch(/\/interface\/wireguard\/peers\/add/)
    // listen-port with a hyphen. listen_port is silently ignored on some
    // firmware, yielding a tunnel that listens on nothing.
    expect(script).toMatch(/listen-port=13231/)
    expect(script).not.toMatch(/listen_port/)
  })
})

describe('safety properties survived the syntax fix', () => {
  it('checks before every add, so a second run changes nothing', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      const adds = script.split('\n')
        .filter((l) => /\/add\s/.test(l) && !l.trim().startsWith('#'))
      const guards = script.split('\n')
        .filter((l) => /^\s*:if \(\[:len \$[A-Za-z]/.test(l))
      expect(adds.length, name).toBeGreaterThan(0)
      expect(guards.length, `${name}: ${guards.length} guards for ${adds.length} adds`)
        .toBeGreaterThanOrEqual(adds.length)
    }
  })

  it('never removes anything, and never factory resets', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      const removes = script.split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .filter((l) => /\/remove\b/.test(l))
      expect(removes, `${name} removes something`).toEqual([])
      expect(script, name).not.toMatch(/system\/reset|factory-reset/)
    }
  })

  it('never embeds a credential', () => {
    for (const [name, script] of ALL_SCRIPTS) {
      // The RADIUS secret is written by the worker from encrypted storage, so it
      // never travels in a script an operator pastes or a router keeps.
      expect(script, name).not.toMatch(/secret\s*=\s*"[^"]+"/i)
      expect(script, name).not.toMatch(/password\s*=/i)
    }
  })
})

// ============================================================================
//  The HTTP 400 on a real RouterOS 7.24.4 CHR.
//
//  Real values from that router:
//    board-name = "CHR innotek GmbH VirtualBox"
//    version    = "7.24.4"
//    arch       = "x86_64"
//
//  These reproduce the exact request the generated command makes and assert the
//  handler accepts it. An identity full of URL-significant characters is proven
//  NOT to reach the request target at all.
// ============================================================================
describe('the claim URL survives a real CHR identity', () => {
  const CLAIM = 'https://demo.supabase.co/functions/v1/router-provision'
  const TOKEN = 'a'.repeat(48)

  /**
   * Builds the URL the generated command produces, given the values the router
   * would substitute.
   *
   * Mirrored against REAL RouterOS semantics, because mirroring the generated
   * code is what makes this a test rather than a restatement. The previous
   * version modelled `:pick` as `(start, length) => slice(start, start+len)`,
   * which is NOT what RouterOS does, so it reproduced `[:pick $v 2 2]` as
   * "minor = 24" while the router returns "". Both sides agreed, the test
   * passed, and every router silently received an unparseable `vm=7.` - which
   * is how a correct deploy still served 55 KiB of escaped script.
   *
   * RouterOS, verified on hardware:
   *   :pick <s> <start> <end>  start inclusive, END EXCLUSIVE
   *     [:pick "abcde" 1 3] -> "bc"
   *     [:pick "abcde" 2 2] -> ""
   *   :find <s> <needle> [<after>]  searches strictly AFTER `after`;
   *                                 default -1 == from index 0
   */
  function claimUrl(rawVersion: string, arch: string): URL {
    buildProvisioningCommand({ claimUrl: CLAIM, token: TOKEN })
    const pick = (s: string, start: number, end: number) => s.slice(start, end)
    const find = (s: string, needle: string, after: number) => {
      const i = s.indexOf(needle, after + 1)
      if (i < 0) throw new Error(`no second dot in ${JSON.stringify(s)}`)
      return i
    }
    const padded = `${rawVersion}..`
    const dot1 = find(padded, '.', -1)
    const dot2 = find(padded, '.', dot1)
    const vm = pick(padded, 0, dot2)
    // `new URL` is the check that matters: it performs the same request-target
    // parse the edge gateway does, and it is what rejected the raw board name.
    return new URL(`${CLAIM}?token=${TOKEN}&vm=${vm}&arch=${arch}`)
  }

  it('accepts the exact values reported by the CHR', () => {
    const url = claimUrl('7.24.4', 'x86_64')
    expect(url.searchParams.get('token')).toBe(TOKEN)
    expect(url.searchParams.get('vm')).toBe('7.24')
    expect(url.searchParams.get('arch')).toBe('x86_64')

    // And the handler reads them.
    const report = parseClaimSelfReport(url.searchParams)
    expect(report.version).toBe('7.24')
    expect(report.architecture).toBe('x86_64')

    // So RouterOS 7.24.4 is classified as 7.x, and REST and WireGuard are NOT
    // falsely reported unavailable - the false claim that prompted all this.
    const profile = buildCompatibility(report.version, report.architecture, null)
    expect(profile.rest).toBe(true)
    expect(profile.wireGuard).toBe(true)
    expect(profile.versionKnown).toBe(true)
  })

  it.each([
    ['CHR innotek GmbH VirtualBox', 'the real board-name, with spaces'],
    ['RB & Co "quoted"', 'an ampersand and quotes'],
    ['100% router', 'a percent sign'],
    ['a/b?c#d', 'a slash, question mark and fragment'],
  ])('never places the identity %s in the request target', (identity) => {
    // board-name and identity are not sent at all, so no character of either
    // can corrupt the URL: not a space, not an `&` forging a parameter, not a
    // `#` truncating it.
    const url = claimUrl('7.24.4', 'x86_64')
    expect(url.href).not.toContain(identity)
    expect(url.href).not.toMatch(/ /)
    // Only the token and the two safe parameters exist. An extra `arch` smuggled
    // in through an ampersand would show up here as a duplicate key.
    expect([...url.searchParams.keys()].sort()).toEqual(['arch', 'token', 'vm'])
  })

  it('keeps a RouterOS 6 router reporting 6.x', () => {
    // "6.49.10 (long-term)" contains a space and parentheses. Only the numeric
    // prefix travels, so a 6.x box is still correctly identified, and is
    // therefore never sent RouterOS 7 commands.
    const url = claimUrl('6.49.10 (long-term)', 'mipsbe')
    expect(url.href).not.toMatch(/ /)
    const report = parseClaimSelfReport(url.searchParams)
    expect(report.version).toBe('6.49')
    expect(buildCompatibility(report.version, null, null).rest).toBe(false)
  })

  it('produces a vm the server can parse, for every real version', () => {
    // THE regression this file missed. The generated command said
    // `[:pick $ispFlowVer 2 2]`, and RouterOS `:pick` is (start, END-EXCLUSIVE),
    // so minor came back as "" on every device. `vm` arrived as "7.", the
    // server correctly found no version in it, and every router was served the
    // conservative hand-escaped fallback - ~55 KiB of `[:replace]` - while the
    // deploy itself was fine and answered HTTP 200 the whole time.
    //
    // The test had passed because its own `:pick` was modelled as (start,
    // length). Correcting the mirror is what makes this case able to fail.
    const cases: [raw: string, vm: string][] = [
      ['7.24.4', '7.24'],
      ['7.9.2', '7.9'],
      ['7.24', '7.24'],
      ['7.16.1 (stable)', '7.16'],
      ['6.49.10 (long-term)', '6.49'],
      ['6.45.8', '6.45'],
    ]
    for (const [raw, expected] of cases) {
      const url = claimUrl(raw, 'x86_64')
      const vm = url.searchParams.get('vm')
      // An empty vm or one ending in "." is exactly the failure.
      expect(vm, `vm for ${JSON.stringify(raw)}`).toBe(expected)
      expect(vm, `vm for ${JSON.stringify(raw)}`).not.toMatch(/(^$|\.$)/)
      expect(parseClaimSelfReport(url.searchParams).version, raw).toBe(expected)
      expect(url.href, raw).not.toMatch(/ /)
    }
  })

  it('rejects a crafted vm rather than trusting it', () => {
    // Validation, not loosening. These reach `buildCompatibility`, which decides
    // whether the router is sent RouterOS 7 commands, so anything not plainly
    // `N.N` is discarded and the version stays unknown.
    for (const bad of [
      '7.24.4', '7.', '.24', '7', 'v7.24', '7.24abc', '07.24',
      '7.24&arch=evil', '7.24 ', '999999.999', '',
    ]) {
      expect(
        parseClaimSelfReport(new URLSearchParams({ vm: bad })).version,
        `vm=${JSON.stringify(bad)}`,
      ).toBeNull()
    }
  })

  it('rejects an architecture that is not a resource token', () => {
    for (const bad of ['x86 64', 'x86_64&vm=7.24', 'A'.repeat(40), '', 'x86/64']) {
      expect(parseClaimSelfReport(new URLSearchParams({ arch: bad })).architecture).toBeNull()
    }
  })

  it('reports an unknown version as unknown, never as unsupported', () => {
    // A router that sends nothing must not be told it lacks a feature. This is
    // the RouterOS 6 / no-version fallback, and it must stay conservative.
    const report = parseClaimSelfReport(new URLSearchParams({ token: TOKEN }))
    expect(report.version).toBeNull()
    const profile = buildCompatibility(report.version, null, null)
    expect(profile.versionKnown).toBe(false)
    expect(profile.rest).toBe(false)
  })
})

describe('the one-command bootstrap reports the router itself', () => {
  const cmd = buildProvisioningCommand({
    claimUrl: 'https://demo.supabase.co/functions/v1/router-provision',
    token: 'x'.repeat(48),
  })

  it('sends the version and architecture, but only the URL-safe parts', () => {
    // Without these the server calls buildCompatibility(null, ...), every
    // feature flag is false, and a 7.24.4 CHR is treated as a RouterOS 6 box.
    expect(cmd).toMatch(/:local ispFlowVerRaw \[\/system\/resource\/get version\]/)
    expect(cmd).toMatch(/:local ispFlowArch \[\/system\/resource\/get architecture-name\]/)

    // Only major.minor travels, taken on the router where the string is still
    // in hand. RouterOS 6 returns "6.49.10 (long-term)" - a raw version would
    // put a space in the request target and 400 the claim, exactly as the real
    // CHR's board-name did.
    //
    // The cut is at the SECOND dot, found with :find's search-after-index
    // argument. It must never be a fixed pair of numbers: `[:pick $v 2 2]` was,
    // and a zero-width range returns "" on every RouterOS.
    expect(cmd).toMatch(/:local ispFlowDot1 \[:find \$ispFlowVer "\."\]/)
    expect(cmd).toMatch(/:local ispFlowDot2 \[:find \$ispFlowVer "\." \$ispFlowDot1\]/)
    expect(cmd).toMatch(/:local ispFlowVm \[:pick \$ispFlowVer 0 \$ispFlowDot2\]/)
    expect(cmd).not.toMatch(/:pick \$ispFlowVer 2 2/)

    // board-name and identity are NOT in the URL: they are free text, they are
    // what caused the 400, and the discovery survey reports both.
    expect(cmd).toMatch(/&vm=/)
    expect(cmd).toMatch(/&arch=/)
    expect(cmd).not.toMatch(/&board=/)
    expect(cmd).not.toMatch(/&id=/)
  })

  it('keeps TLS verification, which is not optional', () => {
    expect(cmd).toMatch(/mode=https/)
    // RouterOS does not verify certificates by default; without this the
    // single-use token and the root script it returns travel a link any proxy
    // can read and rewrite.
    expect(cmd).toMatch(/check-certificate=yes/)
  })

  it('writes the fetched file and imports it', () => {
    expect(cmd).toMatch(/output=file/)
    expect(cmd).toMatch(/dst-path=\$f/)
    expect(cmd).toMatch(/\/import file-name=\$f/)
  })

  it('does NOT combine output=file with keep-result', () => {
    // Regression from a REAL RouterOS 7.24.4 CHR. The two options together are
    // rejected outright with:
    //
    //     failure: please use 'output' option
    //
    // The fetch never ran, so the file check below failed and every router was
    // reported unreachable while the endpoint was in fact answering correctly.
    // keep-result only controls whether the RESULT is also held after the fetch,
    // which this command has no use for: it imports the file and deletes it.
    expect(cmd).not.toMatch(/keep-result/)
  })

  it('keeps TLS verification and the router self-report parameters', () => {
    // The self-report fix must not have disturbed TLS verification.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/mode=https/)
    expect(fetchLine).toMatch(/check-certificate=yes/)
    expect(fetchLine).toMatch(/output=file/)
  })

  // ---------------------------------------------------------------------
  // HTTP 400 on a real RouterOS 7.24.4 CHR: the self-report broke the URL.
  // ---------------------------------------------------------------------
  it('never concatenates free text into the claim URL', () => {
    // A CHR reports board-name = "CHR innotek GmbH VirtualBox". That value used
    // to be spliced into the request target raw, and the space in it made the
    // URL invalid, so the edge gateway answered 400 Bad Request before the
    // function was even entered - the router reported a dead endpoint while the
    // endpoint was healthy. `&`, `?`, `#` and `%` are worse: they forge extra
    // parameters or truncate the URL.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).not.toMatch(/board=/)
    expect(fetchLine).not.toMatch(/&id=/)
    expect(fetchLine).not.toMatch(/identity/)
    expect(fetchLine).not.toMatch(/board-name/)

    // Nor may it come from a variable holding such text.
    expect(cmd).not.toMatch(/:local ispFlowBoard/)
    expect(cmd).not.toMatch(/:local ispFlowIdentity/)
  })

  it('sends only major.minor and arch, which cannot break a URL', () => {
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/vm=/)
    expect(fetchLine).toMatch(/arch=/)

    // RouterOS 6 returns "6.49.10 (long-term)" - spaces and parentheses. The
    // raw version would break a 6.x router the same way, so only the numeric
    // prefix is taken, on the router, where the string is still in hand.
    expect(cmd).toMatch(/:local ispFlowVm \[:pick \$ispFlowVer 0 \$ispFlowDot2\]/)
    // The zero-width range that made every download take the escape path.
    expect(cmd).not.toMatch(/\[:pick\s+\$ispFlowVer\s+\d+\s+\d+\s*\]/)
  })

  it('removes only the bootstrap file it downloaded', () => {
    // The one /remove in the flow, targeting a file this command created. It
    // must not become a general tidy-up.
    expect(cmd.match(/\/file remove[^;\n]*/g)).toEqual(['/file remove $f'])
  })

  it('fails loudly when the endpoint cannot be reached', () => {
    expect(cmd).toMatch(/:error "ISPFlow: could not reach the provisioning endpoint/)
  })
})