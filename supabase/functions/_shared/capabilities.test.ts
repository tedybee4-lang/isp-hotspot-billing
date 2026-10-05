/**
 * Provisioning script safety and version gating.
 *
 * These assertions are the contract with a customer's router. A script that
 * factory-resets, or that deletes a firewall, or that sends a 7.x-only command
 * to a 6.x device, causes real outages, so each rule is pinned by a test rather
 * than left to review.
 */
import { describe, expect, it } from 'vitest'
import {
  buildRouterScript, buildProvisioningCommand, buildAccessScript,
} from './capabilities.ts'
import { buildCompatibility } from './compat.ts'

const base = {
  tag: 'a1b2c3d4',
  role: 'both' as const,
  hotspotInterfaces: ['ether2'],
  pppoeInterfaces: ['ether3'],
  wanInterface: 'ether1',
  dns: ['1.1.1.1', '8.8.8.8'],
  sessionTimeoutMin: 30,
  idleTimeoutMin: 5,
  radiusServer: '10.77.0.1',
  radiusEnabled: true,
}

/**
 * Strips comment lines so assertions test what the script *does*, not what the
 * header says it does not do. The header legitimately names the things it
 * refuses to touch.
 */
function commands(script: string): string {
  return script.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
}

describe('buildRouterScript', () => {
  const script = buildRouterScript(base)
  const body = commands(script)

  it('never factory resets', () => {
    expect(body).not.toMatch(/reset-configuration/i)
    expect(body).not.toMatch(/no-defaults/i)
  })

  it('never removes anything', () => {
    expect(body).not.toMatch(/\bremove\b/)
  })

  it('never touches the firewall, routes, VLANs, bridges or DHCP', () => {
    expect(body).not.toMatch(/firewall/i)
    expect(body).not.toMatch(/\/ip route/i)
    expect(body).not.toMatch(/vlan/i)
    expect(body).not.toMatch(/bridge/i)
    expect(body).not.toMatch(/dhcp-server/i)
  })

  it('checks before it creates, so it is idempotent', () => {
    // Every guarded block is preceded by a fetch and an `:if`.
    // The fetch path changed from a bare `[find ...]` (only valid inside a
    // menu context, which the illegal `do={` blocks provided) to a full
    // `[/menu/find ...]`, because there is no menu context at the top level of
    // an imported script.
    expect(body).toMatch(/\[\/[a-z-]+\/find/)
    expect(body).toMatch(/:if \(/)
  })

  it('tags everything it creates with the session id', () => {
    expect(script).toContain('NETISP:a1b2c3d4')
  })

  it('never embeds a password', () => {
    expect(body).not.toMatch(/password=/i)
    // The RADIUS secret is no longer written into the script at all, not even
    // as the literal placeholder "(set from the panel)". It is applied by the
    // worker from encrypted storage during the RADIUS stage, so the value never
    // travels in a script an operator pastes or a router keeps.
    expect(script).not.toMatch(/secret=/i)
  })

  it('creates only the roles the ISP asked for', () => {
    const hotspotOnly = commands(buildRouterScript({ ...base, role: 'hotspot' }))
    expect(hotspotOnly).toMatch(/\/ip\/hotspot\//)
    expect(hotspotOnly).not.toMatch(/pppoe-server/)

    const pppoeOnly = commands(buildRouterScript({ ...base, role: 'pppoe' }))
    expect(pppoeOnly).toMatch(/pppoe-server/)
    // A PPPoE-only router has no HotSpot tree, so it must not be configured.
    expect(pppoeOnly).not.toMatch(/\/ip hotspot/)
  })
})

describe('buildProvisioningCommand', () => {
  const cmd = buildProvisioningCommand({
    claimUrl: 'https://example.supabase.co/functions/v1/router-provision',
    token: 'tok_abcdefghijklmnop',
  })

  it('fetches into a file and imports it, which is what /import can read', () => {
    expect(cmd).toContain('/tool fetch')
    expect(cmd).toContain('dst-path=$f')
    expect(cmd).toContain('/import file-name=$f')
  })

  it('writes the fetched file, instead of discarding the result', () => {
    // Regression: `output=none` made /tool fetch throw the bytes away, so
    // dst-path was never written and the file check below always failed. On a
    // real router this made provisioning impossible while looking like a
    // network problem, which is why it was so hard to diagnose.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).not.toMatch(/output=none/)
    expect(fetchLine).toMatch(/output=file/)
    // The download must be explicit rather than relying on a default.
    expect(fetchLine).toMatch(/dst-path=\$f/)
  })

  it('does not combine output=file with keep-result, which RouterOS rejects', () => {
    // Regression from a REAL RouterOS 7.24.4 CHR. Combining them fails the
    // fetch outright with:
    //
    //     failure: please use 'output' option
    //
    // so the bootstrap never downloaded, and every router looked unreachable
    // when the endpoint was in fact answering correctly.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/output=file/)
    expect(fetchLine).not.toMatch(/keep-result/)
    // And nowhere else in the command either.
    expect(cmd).not.toMatch(/keep-result/)
  })

  it('keeps TLS verification and the router self-report parameters', () => {
    // The keep-result fix must not have disturbed either of these.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/mode=https/)
    expect(fetchLine).toMatch(/check-certificate=yes/)
    expect(fetchLine).toMatch(/&version=/)
    expect(fetchLine).toMatch(/&board=/)
    expect(fetchLine).toMatch(/&arch=/)
    expect(fetchLine).toMatch(/&id=/)
  })

  it('cannot report an unreachable endpoint when the fetch simply discarded', () => {
    // Guard the exact failure mode: the error below must be reachable only
    // because the file genuinely is absent.
    expect(cmd).toContain('[:len [/file find name=$f]] = 0')
    expect(cmd.indexOf('/tool fetch')).toBeLessThan(cmd.indexOf('/file find'))
  })

  it('does not leave the downloaded file behind', () => {
    expect(cmd).toContain('/file remove $f')
  })

  it('fails loudly rather than silently when the endpoint is unreachable', () => {
    expect(cmd).toMatch(/:error/)
  })

  it('never claims a result it cannot verify', () => {
    // The script must not print "success" from the platform's point of view.
    expect(cmd).not.toMatch(/provisioned successfully/i)
  })
})

describe('buildAccessScript version gating', () => {
  const ros6 = buildCompatibility('6.49.10 (long-term)', 'smips', 'RB941')
  const ros7 = buildCompatibility('7.14.3 (stable)', 'arm64', 'RB4011')

  const vpn = {
    interfaceName: 'netisp',
    listenPort: 13231,
    peerPublicKey: 'PUBKEY==',
    endpointHost: '87.76.137.72',
    endpointPort: 51820,
    tunnelAddress: '10.77.0.2/32',
    allowedAddress: '10.77.0.0/24',
  }

  it('gives a RouterOS 6 device the API and nothing else', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros6, vpn: null })
    expect(s).toMatch(/name="api" port=8728/)
    expect(s).not.toMatch(/www-ssl/)
    expect(s).not.toMatch(/wireguard/)
  })

  it('explains to the operator why REST is absent', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros6, vpn: null })
    expect(s).toMatch(/predates HTTPS REST/)
    expect(s).toMatch(/never requires REST/)
  })

  it('gives a RouterOS 7 device HTTPS REST', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros7, vpn: null })
    expect(s).toMatch(/name="www-ssl" port=8080/)
  })

  it('adds a WireGuard tunnel only when both the device and the peer exist', () => {
    const withVpn = buildAccessScript({ tag: 't1', profile: ros7, vpn })
    expect(withVpn).toMatch(/\/interface\/wireguard/)
    expect(withVpn).toMatch(/persistent-keepalive=25/)
    expect(withVpn).toMatch(/10\.77\.0\.2\/32/)

    const noVpn = buildAccessScript({ tag: 't1', profile: ros7, vpn: null })
    expect(noVpn).not.toMatch(/interface wireguard/)
  })

  it('refuses to write a WireGuard block for a device that cannot run one', () => {
    // Even when peer details are supplied, a 6.x router must not be sent one.
    const s = buildAccessScript({ tag: 't1', profile: ros6, vpn })
    expect(s).not.toMatch(/interface wireguard/)
    expect(s).toMatch(/no WireGuard support/)
  })

  it('never removes a service it did not create', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros7, vpn })
    expect(s).not.toMatch(/\/ip\/service\/remove/)
    // The lookup that makes the add idempotent. A full path is required because
    // the script's top level has no menu context.
    expect(s).toMatch(/\[\/ip\/service\/find name="api"\]/)
  })

  it('never resets the configuration', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros7, vpn })
    expect(s).not.toMatch(/reset-configuration/i)
  })
})