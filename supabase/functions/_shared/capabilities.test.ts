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
    // RouterOS CLI paths use menu words separated by spaces, not API-style
    // slash-delimited paths such as `/ip/hotspot/add`.
    expect(body).toMatch(/\[\/[a-z-]+ [a-z-]+ find/)
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
    expect(hotspotOnly).toMatch(/\/ip hotspot /)
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
    expect(cmd).toContain('dst-path=ispflow-bootstrap.rsc')
    expect(cmd).toContain('/import file-name=ispflow-bootstrap.rsc')
  })

  it('writes the fetched file, instead of discarding the result', () => {
    // Regression: `output=none` made /tool fetch throw the bytes away, so
    // dst-path was never written and the import below always failed. On a
    // real router this made provisioning impossible while looking like a
    // network problem, which is why it was so hard to diagnose.
    expect(cmd).not.toMatch(/output=none/)
    expect(cmd).toMatch(/output=file/)
    // The download must be explicit rather than relying on a default.
    expect(cmd).toMatch(/dst-path=ispflow-bootstrap\.rsc/)
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

  it('uses HTTPS and reads the self-report parameters from this router', () => {
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).toMatch(/mode=https/)
    expect(fetchLine).toMatch(/check-certificate=yes/)
    expect(cmd).toContain('/system resource get version')
    expect(cmd).toContain('/system resource get architecture-name')
    expect(cmd).toContain('&vm=')
    expect(cmd).toContain('&arch=')
    expect(cmd).not.toContain('&vm=7')
    expect(cmd).not.toContain('&arch=x86_64')
  })

  it('keeps free text out of the request target', () => {
    // Regression from a REAL RouterOS 7.24.4 CHR, which answers:
    //
    //     board-name = "CHR innotek GmbH VirtualBox"
    //
    // That value used to be concatenated into the URL raw. The space made the
    // request target invalid and the edge gateway returned 400 Bad Request
    // before the function ran, so the router reported an unreachable endpoint
    // while the endpoint was healthy. Free text must not appear here at all:
    // `&` would forge a parameter and `#` would truncate the URL. The discovery
    // survey reports identity and board_name instead.
    const fetchLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(fetchLine).not.toMatch(/&board=/)
    expect(fetchLine).not.toMatch(/&id=/)
    expect(cmd).not.toMatch(/:local ispFlowBoard/)
    expect(cmd).not.toMatch(/:local ispFlowIdentity/)
  })

  it('fetches, imports, then removes - in that order', () => {
    // Order matters: importing before the file exists fails, and removing
    // before the import would delete the file the router is about to read.
    const fetch = cmd.indexOf('/tool fetch')
    const imp = cmd.indexOf('/import file-name=')
    const remove = cmd.indexOf('/file remove ')
    expect(fetch).toBeGreaterThanOrEqual(0)
    expect(fetch).toBeLessThan(imp)
    expect(imp).toBeLessThan(remove)
  })

  it('does not leave the downloaded file behind', () => {
    expect(cmd).toContain('/file remove ispflow-bootstrap.rsc')
  })

  it('is exactly the documented one-line contract', () => {
    expect(cmd).toMatch(/^:local ispflowVersion \[\/system resource get version\];/)
    expect(cmd).toContain('/tool fetch url=("https://example.supabase.co/functions/v1/router-provision?token=tok_abcdefghijklmnop&vm=" . $ispflowVersion . "&arch=" . $ispflowArch)')
    expect(cmd).toContain('mode=https check-certificate=yes output=file dst-path=ispflow-bootstrap.rsc;')
    expect(cmd).toContain('/import file-name=ispflow-bootstrap.rsc; /file remove ispflow-bootstrap.rsc;')
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
    expect(withVpn).toMatch(/\/interface wireguard/)
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
    expect(s).not.toMatch(/\/ip service remove/)
    // The lookup that makes the add idempotent. A full path is required because
    // the script's top level has no menu context.
    expect(s).toMatch(/\[\/ip service find name="api"\]/)
  })

  it('never resets the configuration', () => {
    const s = buildAccessScript({ tag: 't1', profile: ros7, vpn })
    expect(s).not.toMatch(/reset-configuration/i)
  })
})