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
  buildAccessScript, buildProvisioningCommand, buildRouterScript,
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

describe('the one-command bootstrap reports the router itself', () => {
  const cmd = buildProvisioningCommand({
    claimUrl: 'https://demo.supabase.co/functions/v1/router-provision',
    token: 'x'.repeat(48),
  })

  it('sends version, board, architecture and identity', () => {
    // Without these the server calls buildCompatibility(null, ...), every
    // feature flag is false, and a 7.24.4 CHR is treated as a RouterOS 6 box.
    expect(cmd).toMatch(/:local v \[\/system\/resource\/get version\]/)
    expect(cmd).toMatch(/:local b \[\/system\/resource\/get board-name\]/)
    expect(cmd).toMatch(/:local a \[\/system\/resource\/get architecture-name\]/)
    expect(cmd).toMatch(/:local n \[\/system\/identity\/get name\]/)
    expect(cmd).toMatch(/&version=.*&board=.*&arch=.*&id=/)
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

  it('keeps TLS verification and the self-report parameters', () => {
    // The keep-result fix must not have disturbed either of these.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/mode=https/)
    expect(fetchLine).toMatch(/check-certificate=yes/)
    expect(fetchLine).toMatch(/output=file/)
    expect(fetchLine).toMatch(/&version=.*&board=.*&arch=.*&id=/)
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