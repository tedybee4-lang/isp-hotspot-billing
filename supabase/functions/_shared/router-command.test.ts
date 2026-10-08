import { describe, expect, it } from 'vitest'
import { validateRouterOsScript } from '../../../src/test/routeros-validate'
import { HOTSPOT_ASSETS } from './hotspot-assets.ts'
import {
  assessAutoHotspot,
  buildAutoHotspotScript,
  type RouterSurvey,
} from './router-command.ts'

function fixture(): RouterSurvey[] {
  return [
    { survey: 'dhcp-clients', payload: [{ interface: 'ether1', status: 'bound', add_default_route: 'yes', gateway: '172.31.0.2', disabled: 'false' }] },
    { survey: 'routes', payload: [{ dst_address: '0.0.0.0/0', gateway: '172.31.0.2', active: 'true', disabled: 'false' }] },
    { survey: 'bridge', payload: [{ name: 'bridge-hotspot', disabled: 'false' }] },
    { survey: 'bridge_ports', payload: [{ bridge: 'bridge-hotspot', interface: 'wlan1', disabled: 'false' }] },
    { survey: 'ip_addresses', payload: [{ interface: 'bridge-hotspot', address: '192.168.88.1/24', dynamic: 'false', disabled: 'false' }] },
    { survey: 'dhcp', payload: [{ name: 'hotspot-dhcp', interface: 'bridge-hotspot', address_pool: 'hotspot-pool', disabled: 'false' }] },
    { survey: 'dhcp-networks', payload: [{ address: '192.168.88.0/24', gateway: '192.168.88.1', 'dns-server': '192.168.88.1' }] },
    { survey: 'ip_pools', payload: [{ name: 'hotspot-pool', ranges: '192.168.88.10-192.168.88.254' }] },
    { survey: 'hotspot', payload: [] },
    { survey: 'hotspot-users', payload: [{ name: 'active-customer', profile: 'default', server: 'all' }] },
    { survey: 'radius', payload: [] },
    { survey: 'nat', payload: [{ chain: 'srcnat', action: 'masquerade', 'out-interface-list': 'WAN', disabled: 'false' }] },
    { survey: 'interface-lists', payload: [{ name: 'WAN' }] },
    { survey: 'interface-list-members', payload: [{ list: 'WAN', interface: 'ether1', disabled: 'false' }] },
    { survey: 'firewall', payload: [] },
    { survey: 'dns', payload: [{ allow_remote_requests: 'true' }] },
  ]
}

describe('router-pull HotSpot assessment', () => {
  it('recognises the hAP lite topology and uses only its existing LAN/DHCP', () => {
    const result = assessAutoHotspot(fixture())
    expect(result).toEqual({
      ok: true,
      plan: {
        wan: 'ether1',
        lan: 'bridge-hotspot',
        address: '192.168.88.1/24',
        gateway: '192.168.88.1',
        network: '192.168.88.0/24',
        pool: 'hotspot-pool',
        addNat: false,
        addForward: true,
        useRadius: false,
        authenticationReady: true,
      },
    })
  })

  it('fails closed when discovery is incomplete or multiple WANs are active', () => {
    expect(assessAutoHotspot(fixture().slice(0, 4))).toMatchObject({ ok: false })
    const ambiguous = fixture()
    ambiguous[0].payload = [
      ...(ambiguous[0].payload as unknown[]),
      { interface: 'ether2', status: 'bound', add_default_route: 'yes', gateway: '172.31.1.1' },
    ]
    ;(ambiguous[1].payload as unknown[]).push({
      dst_address: '0.0.0.0/0', gateway: '172.31.1.1', active: 'yes',
    })
    expect(assessAutoHotspot(ambiguous)).toMatchObject({ ok: false })
  })

  it('does not enable the router DNS proxy when DHCP points at a disabled resolver', () => {
    const surveys = fixture()
    surveys[15].payload = [{ allow_remote_requests: 'false' }]
    expect(assessAutoHotspot(surveys)).toMatchObject({ ok: false })
  })

  it('reports missing customer authentication instead of asserting readiness', () => {
    const surveys = fixture()
    surveys[9].payload = []
    const result = assessAutoHotspot(surveys)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.authenticationReady).toBe(false)
  })

  it('refuses unsafe interface names rather than emitting RouterOS source from them', () => {
    const surveys = fixture()
    surveys[0].payload = [{
      interface: 'ether1; /system reboot', status: 'bound',
      add_default_route: 'yes', gateway: '172.31.0.2',
    }]
    expect(assessAutoHotspot(surveys)).toMatchObject({ ok: false })
  })

  it('refuses DHCP pools outside the discovered customer subnet', () => {
    const surveys = fixture()
    surveys[7].payload = [{ name: 'hotspot-pool', ranges: '10.0.0.10-10.0.0.250' }]
    expect(assessAutoHotspot(surveys)).toMatchObject({ ok: false })
  })
})

describe('router-pull HotSpot script and portal assets', () => {
  it('is valid RouterOS, idempotent, certificate-verified and bounded to known assets', () => {
    const assessed = assessAutoHotspot(fixture())
    if (!assessed.ok) throw new Error(assessed.reason)
    const generated = buildAutoHotspotScript({
      baseUrl: 'https://project.supabase.co/functions/v1/router-provision',
      heartbeatToken: 'a'.repeat(64),
      commandId: '0dd3b452-526f-4df4-801c-0521928eaf55',
      tag: 'ab12cd34',
      plan: assessed.plan,
      assetNames: Object.keys(HOTSPOT_ASSETS),
    })
    expect(validateRouterOsScript(generated)).toEqual([])
    expect(generated).toContain('check-certificate=yes')
    expect(generated).toContain('login-by=http-chap')
    expect(generated).toContain('place-before=0')
    expect(generated).toContain('http-data=')
    expect(generated).not.toContain('password=')
    const noAuthScript = buildAutoHotspotScript({
      baseUrl: 'https://project.supabase.co/functions/v1/router-provision',
      heartbeatToken: 'a'.repeat(64),
      commandId: '0dd3b452-526f-4df4-801c-0521928eaf55',
      tag: 'ab12cd34',
      plan: { ...assessed.plan, authenticationReady: false },
      assetNames: Object.keys(HOTSPOT_ASSETS),
    })
    expect(noAuthScript).toContain('customer access is not ready')
    expect(() => buildAutoHotspotScript({
      baseUrl: 'https://project.supabase.co/functions/v1/router-provision',
      heartbeatToken: 'a'.repeat(64),
      commandId: '0dd3b452-526f-4df4-801c-0521928eaf55',
      tag: 'ab12cd34',
      plan: { ...assessed.plan, wan: 'ether1"; /system reboot' },
      assetNames: ['../login.html'],
    })).toThrow(/invalid plan data/)
  })

  it('ships all required local CHAP portal pages and the hash implementation', () => {
    expect(Object.keys(HOTSPOT_ASSETS).sort()).toEqual([
      'alogin.html', 'error.html', 'login.html', 'logout.html', 'md5.js',
      'status.html', 'style.css',
    ])
    expect(HOTSPOT_ASSETS['login.html'].body).toContain('$(chap-challenge)')
    expect(HOTSPOT_ASSETS['login.html'].body).toContain('hexMD5(id + form.password.value + challenge)')
    expect(HOTSPOT_ASSETS['md5.js'].body).toContain('function hexMD5(value)')
  })
})
