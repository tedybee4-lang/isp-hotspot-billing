/**
 * RouterOS compatibility rules.
 *
 * Requirement 26 and 27: an hAP lite / RB941-2nD running RouterOS 6 must
 * register and be manageable, and CHR must behave like any other router. Both
 * are asserted here rather than being hoped for, because no physical device is
 * attached to the build machine.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCompatibility, describeBoard, parseVersion, supportsRest, supportsWireGuard,
  isAtLeast, supportsBridgeVlanFiltering, supportsContainers, LOW_RESOURCE_CLASSES,
} from './compat.ts'

describe('parseVersion', () => {
  it('parses a 7.x stable release with a channel', () => {
    expect(parseVersion('7.14.3 (stable)')).toMatchObject({
      major: 7, minor: 14, patch: 3, channel: 'stable',
    })
  })

  it('parses a 6.x long-term release', () => {
    expect(parseVersion('6.49.10 (long-term)')).toMatchObject({ major: 6, minor: 49 })
  })

  it('parses a two-part version with no patch', () => {
    expect(parseVersion('7.1')).toMatchObject({ major: 7, minor: 1, patch: 0 })
  })

  it('returns null rather than a guess when there is nothing to parse', () => {
    expect(parseVersion(null)).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('unknown')).toBeNull()
  })
})

describe('feature gates', () => {
  it('treats REST as 7.1 and later', () => {
    expect(supportsRest(parseVersion('7.0.6 (stable)'))).toBe(false)
    expect(supportsRest(parseVersion('7.1 (stable)'))).toBe(true)
    expect(supportsRest(parseVersion('7.14.3 (stable)'))).toBe(true)
    expect(supportsRest(parseVersion('6.49.10 (long-term)'))).toBe(false)
  })

  it('treats WireGuard as 7.1 and later', () => {
    expect(supportsWireGuard(parseVersion('6.49.10'))).toBe(false)
    expect(supportsWireGuard(parseVersion('7.1'))).toBe(true)
  })

  it('gates bridge VLAN filtering on 6.41', () => {
    expect(supportsBridgeVlanFiltering(parseVersion('6.40'))).toBe(false)
    expect(supportsBridgeVlanFiltering(parseVersion('6.41'))).toBe(true)
  })

  it('gates containers on 7.4', () => {
    expect(supportsContainers(parseVersion('7.3'))).toBe(false)
    expect(supportsContainers(parseVersion('7.4'))).toBe(true)
  })

  it('orders a major-version jump correctly', () => {
    expect(isAtLeast(parseVersion('8.0'), 7, 1)).toBe(true)
    expect(isAtLeast(parseVersion('6.49'), 7, 0)).toBe(false)
  })
})
describe('hAP lite / RB941-2nD on RouterOS 6', () => {
  // The explicit requirement: registering this device must not fail because it
  // lacks modern features. It is manageable through the plain API.
  const profile = buildCompatibility('6.49.10 (long-term)', 'smips', 'RB941')

  it('is classified as a low-resource SMIPS device', () => {
    expect(profile.hardwareClass).toBe('smips')
    expect(LOW_RESOURCE_CLASSES).toContain(profile.hardwareClass)
  })

  it('reports REST as unavailable rather than pretending', () => {
    expect(profile.rest).toBe(false)
    expect(profile.unsupported).toContain('rest')
  })

  it('reports WireGuard as unavailable', () => {
    expect(profile.wireGuard).toBe(false)
    expect(profile.unsupported).toContain('wireguard')
  })

  it('still offers the API, which is the only way in', () => {
    expect(profile.api).toBe(true)
    expect(profile.apiSsl).toBe(true)
  })

  it('explains the CGNAT consequence in words the panel can show', () => {
    expect(profile.managementNote).toMatch(/6\.49\.10/)
    expect(profile.managementNote).toMatch(/API/)
    expect(profile.managementNote).toMatch(/CGNAT/)
  })

  it('is polled less often so a sweep cannot starve 32 MB of RAM', () => {
    expect(profile.suggestedHeartbeatSecs).toBeGreaterThan(60)
  })

  it('does not treat the device as unsupported overall', () => {
    // The single most important assertion: absence of REST must not make the
    // device unmanageable.
    expect(profile.inboundManagementPossible).toBe(true)
  })
})

describe('CHR', () => {
  it('is recognised from its license level, the only reliable signal', () => {
    // A CHR install reports an ordinary version string, so the version cannot
    // be used to detect it.
    const p = buildCompatibility('7.16.2 (stable)', 'x86', 'RouterOS', 'CHR')
    expect(p.isChr).toBe(true)
    expect(p.rest).toBe(true)
    expect(p.wireGuard).toBe(true)
  })

  it('falls back to the board name when the license level is unavailable', () => {
    expect(buildCompatibility('7.14.3 (stable)', 'x86', 'CHR').isChr).toBe(true)
  })

  it('treats a nameless x86 device as CHR', () => {
    // An x86 install with no board name is a CHR by definition: RouterBOARD
    // hardware is never x86.
    expect(buildCompatibility('7.14.3 (stable)', 'x86', null).isChr).toBe(true)
  })

  it('does not misidentify RouterBOARD hardware as CHR', () => {
    expect(buildCompatibility('7.14.3 (stable)', 'arm64', 'RB4011').isChr).toBe(false)
    expect(buildCompatibility('7.14.3 (stable)', 'mips64', 'RB5009').isChr).toBe(false)
  })

  it('drops the hardware readings a virtual device cannot provide', () => {
    const profile = buildCompatibility('7.14.3 (stable)', 'x86', 'CHR')
    expect(profile.unsupported).toContain('board-temperature')
    expect(profile.unsupported).toContain('serial-number')
  })
})

describe('high-end devices', () => {
  it('classifies RB5009 as 64-bit MIPS', () => {
    const p = buildCompatibility('7.14.3 (stable)', 'mips64', 'RB5009')
    expect(p.hardwareClass).toBe('mips64')
    expect(p.rest).toBe(true)
    expect(p.suggestedHeartbeatSecs).toBe(60)
  })

  it('classifies CCR as 64-bit MIPS', () => {
    expect(buildCompatibility('7.15 (stable)', 'mips64', 'CCR2004-1G-12S+2XS').hardwareClass)
      .toBe('mips64')
  })

  it('classifies RB4011 as arm64', () => {
    expect(buildCompatibility('7.14.3 (stable)', 'arm64', 'RB4011').hardwareClass)
      .toBe('arm64')
  })

  it('keeps a 6.x CCR manageable on the API only', () => {
    const p = buildCompatibility('6.49.10', 'mips64', 'CCR1009')
    expect(p.rest).toBe(false)
    expect(p.api).toBe(true)
  })
})

describe('arch/board classification', () => {
  it('classifies the rest of the documented range', () => {
    expect(buildCompatibility('7.14.3', 'smips', 'RB951').hardwareClass).toBe('smips')
    expect(buildCompatibility('7.14.3', 'arm', 'hAP ac3').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'arm', 'cAP ax2').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'arm', 'wAP ac').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'arm', 'mAP ax2').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'arm', 'Audience').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'mipsbe', 'RB750Gr3').hardwareClass).toBe('mipsbe')
    expect(buildCompatibility('7.14.3', 'arm', 'hEX S').hardwareClass).toBe('arm')
    expect(buildCompatibility('7.14.3', 'arm', 'CRS3xx').hardwareClass).toBe('arm')
  })

  it('falls back to unknown without inventing a class', () => {
    expect(buildCompatibility('7.14.3', null, null).hardwareClass).toBe('unknown')
    expect(buildCompatibility(null, null, null).hardwareClass).toBe('unknown')
  })
})

describe('describeBoard', () => {
  it('names the devices the platform has explicit knowledge of', () => {
    expect(describeBoard('RB941', 'smips')).toBe('hAP lite (RB941-2nD)')
    expect(describeBoard('hAP lite', 'smips')).toBe('hAP lite (RB941-2nD)')
    expect(describeBoard('RB5009', 'mips64')).toBe('RB5009')
    expect(describeBoard('CHR', 'x86')).toBe('CHR')
  })

  it('passes an unknown board name through rather than hiding it', () => {
    expect(describeBoard('SomeNewBox-9', 'arm')).toBe('SomeNewBox-9')
  })

  it('describes a nameless device from its architecture', () => {
    expect(describeBoard(null, 'smips')).toBe('SMIPS device (RouterBOARD)')
    expect(describeBoard(null, 'x86')).toBe('x86 / CHR')
    expect(describeBoard(null, null)).toBe('Unknown device')
  })
})