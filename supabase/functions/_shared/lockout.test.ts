/**
 * Management lockout: the check that stops ISPFlow locking an ISP out of its
 * own router.
 *
 * Every test is built from DISCOVERED state rather than the ether1/WAN
 * assumption the old design used. The property that matters most is the last
 * group: an override must not be able to say yes on its own.
 */
import { describe, expect, it } from 'vitest'
import {
  managementPorts, assessLockout,
  type DiscoveredInterface, type DiscoveredAddress, type DiscoveredBridge,
} from './lockout.ts'

// A realistic hAP: a LAN bridge holding the management address, one upstream
// port and spare ports. Nothing here is named ether1/WAN on purpose - the
// router reports whatever it reports.
const IFACES: DiscoveredInterface[] = [
  { name: 'bridge', type: 'bridge' },
  { name: 'ether1', type: 'ether' },
  { name: 'ether2', type: 'ether' },
  { name: 'ether3', type: 'ether' },
  { name: 'ether4', type: 'ether' },
  { name: 'ether5', type: 'ether' },
  { name: 'wlan1', type: 'wlan' },
]
const ADDRESSES: DiscoveredAddress[] = [
  { address: '192.168.88.1/24', interface: 'bridge' },
  { address: '10.0.0.1/30', interface: 'ether1' },
]
const BRIDGES: DiscoveredBridge[] = [{ name: 'bridge' }]

const discovered = { interfaces: IFACES, addresses: ADDRESSES, bridges: BRIDGES }

describe('which ports count as management', () => {
  it('finds the bridge holding the LAN address', () => {
    expect(managementPorts(IFACES, ADDRESSES, BRIDGES)).toContain('bridge')
  })

  it('does not treat the upstream port as management', () => {
    // ether1 holds the address to the ISP's upstream. That is how the ROUTER
    // reaches the internet, not how a human reaches the router.
    expect(managementPorts(IFACES, ADDRESSES, BRIDGES)).not.toContain('ether1')
  })

  it('trusts an operator comment naming a port for management', () => {
    const ifaces: DiscoveredInterface[] = [
      { name: 'sfp1', type: 'ether', comment: 'console - management only' },
    ]
    expect(managementPorts(ifaces, [], []).has('sfp1')).toBe(true)
  })

  it('ignores a disabled port even if it holds an address', () => {
    const ifaces: DiscoveredInterface[] = [
      { name: 'ether9', type: 'ether', disabled: true },
    ]
    const addrs: DiscoveredAddress[] = [{ address: '10.9.9.1/24', interface: 'ether9' }]
    expect(managementPorts(ifaces, addrs, BRIDGES).has('ether9')).toBe(false)
  })

  it('ignores the loopback address', () => {
    expect(managementPorts(IFACES, [
      { address: '127.0.0.1/8', interface: 'lo' },
    ], BRIDGES).has('lo')).toBe(false)
  })

  it('finds nothing on a router with no addresses and no comments', () => {
    expect(managementPorts([{ name: 'ether1', type: 'ether' }], [], []).size).toBe(0)
  })
})

describe('a configuration that keeps a way in is allowed', () => {
  it('accepts a plan that leaves the bridge alone', () => {
    const a = assessLockout({
      wan: 'ether1', hotspot: ['ether2'], pppoe: ['ether3'], management: ['bridge'],
    }, discovered)
    expect(a.safe).toBe(true)
    expect(a.remedy).toBeNull()
  })

  it('accepts moving the LAN to a new port, keeping the bridge for management', () => {
    const a = assessLockout({
      wan: 'ether1', hotspot: ['bridge'], pppoe: ['ether3'], management: ['ether2'],
    }, discovered)
    expect(a.safe).toBe(true)
    // A warning, but management demonstrably survives.
    expect(a.losingManagement).toContain('bridge')
    expect(a.message).toMatch(/ether2/)
  })
})

describe('a configuration with no way back is refused', () => {
  it('refuses when every port is handed to a customer service', () => {
    const a = assessLockout({
      wan: 'ether1',
      hotspot: ['bridge', 'ether2', 'ether3'],
      pppoe: ['ether4', 'ether5'],
      management: ['bridge'],
    }, discovered)
    expect(a.safe).toBe(false)
    expect(a.message).toMatch(/remove every way to manage/)
  })

  it('refuses when the nominated management port was never discovered', () => {
    // Naming a port that discovery never saw must not pass silently.
    expect(assessLockout({
      wan: 'ether1', hotspot: ['ether2'], pppoe: ['ether3'], management: ['ether99'],
    }, discovered).safe).toBe(false)
  })

  it('refuses a disabled nominated port', () => {
    expect(assessLockout({
      wan: 'ether1', hotspot: ['ether2'], pppoe: ['ether3'],
      management: ['ether6'],
    }, {
      ...discovered,
      interfaces: [...IFACES, { name: 'ether6', type: 'ether', disabled: true }],
    }).safe).toBe(false)
  })

  it('suggests the free ports when there are some', () => {
    const a = assessLockout({
      wan: 'ether1', hotspot: ['bridge'], pppoe: ['ether3'], management: ['bridge'],
    }, discovered)
    expect(a.remedy).toMatch(/ether2/)
  })

  it('says so when every port is already assigned', () => {
    const a = assessLockout({
      wan: 'ether1',
      hotspot: ['bridge', 'ether2', 'ether3', 'ether4'],
      pppoe: ['ether5', 'wlan1'],
      management: ['bridge'],
    }, discovered)
    expect(a.remedy).toMatch(/Every port on this router is assigned/)
  })
})

describe('accepting the risk does not bypass safety on its own', () => {
  const lockout = {
    wan: 'ether1',
    hotspot: ['bridge', 'ether2', 'ether3'],
    pppoe: ['ether4', 'ether5'],
    management: ['bridge'],
  }

  it('still refuses when acceptLockout is set with no replacement path', () => {
    // SAFETY: a checkbox saying "I accept" is not a way back in.
    expect(assessLockout({ ...lockout, acceptLockout: true }, discovered).safe)
      .toBe(false)
  })

  it('explains that acceptance alone is not enough', () => {
    expect(assessLockout({ ...lockout, acceptLockout: true }, discovered).message)
      .toMatch(/not enough on its own/)
  })

  it('still refuses when the replacement path is "none"', () => {
    expect(assessLockout({
      ...lockout, acceptLockout: true,
      replacementPath: { kind: 'none', verified: true },
    }, discovered).safe).toBe(false)
  })

  it('still refuses when a real path has not been verified to exist', () => {
    expect(assessLockout({
      ...lockout, acceptLockout: true,
      replacementPath: { kind: 'console-server', verified: false },
    }, discovered).safe).toBe(false)
  })

  it('allows the override only with a verified out-of-band path', () => {
    const a = assessLockout({
      ...lockout, acceptLockout: true,
      replacementPath: {
        kind: 'console-server', verified: true, note: 'site console, rack 4',
      },
    }, discovered)
    expect(a.safe).toBe(true)
    expect(a.message).toMatch(/console server/)
    // The risk must stay visible in the record, not vanish once overridden.
    expect(a.message).toMatch(/rack 4/)
  })

  it('does not treat a verified path alone as permission', () => {
    expect(assessLockout({
      ...lockout, replacementPath: { kind: 'on-site', verified: true },
    }, discovered).safe).toBe(false)
  })
})