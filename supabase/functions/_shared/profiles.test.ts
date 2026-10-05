/**
 * Package to router-profile generation.
 *
 * The tests that matter most are the ones about what happens when a package is
 * wrong. An ISP typing "fast" into the speed box must not produce a profile with
 * no rate limit on it: that is unlimited bandwidth, sold as a metered package,
 * on a router serving paying customers.
 */
import { describe, expect, it } from 'vitest'
import {
  parseSpeedMbps, toRateLimit, sanitizeObjectName, planProfiles,
  planProfilesStrict, planProfilesStrictAll, plansToSync, servicesNeeded,
  ProfileSpeedError, type PlanRow,
} from './profiles.ts'

const plan = (over: Partial<PlanRow> = {}): PlanRow => ({
  id: 'p1', name: 'Home 5M', kind: 'hotspot', price: 500,
  speed_down: '5 Mbps', speed_up: '2 Mbps',
  duration_label: 'Monthly', duration_hours: 720,
  is_active: true, show_on_portal: true,
  ...over,
})

describe('reading a speed the ISP typed', () => {
  it('reads the plain forms', () => {
    expect(parseSpeedMbps('10')).toBe(10)
    expect(parseSpeedMbps('10 Mbps')).toBe(10)
    expect(parseSpeedMbps('10Mbps')).toBe(10)
    expect(parseSpeedMbps('10 Mb/s')).toBe(10)
    expect(parseSpeedMbps('  25 mbps ')).toBe(25)
  })

  it('converts kilobits and gigabits to one internal unit', () => {
    expect(parseSpeedMbps('512k')).toBeCloseTo(0.512)
    expect(parseSpeedMbps('512kbps')).toBeCloseTo(0.512)
    expect(parseSpeedMbps('1G')).toBe(1000)
    expect(parseSpeedMbps('1 Gbps')).toBe(1000)
  })

  it('returns null rather than guessing', () => {
    // Null is a signal to stop. Defaulting here is how unlimited gets shipped.
    expect(parseSpeedMbps('fast')).toBeNull()
    expect(parseSpeedMbps('')).toBeNull()
    expect(parseSpeedMbps(null)).toBeNull()
    expect(parseSpeedMbps('0')).toBeNull()
  })
})

describe('writing a rate limit RouterOS understands', () => {
  it('writes megabits the normal way', () => {
    expect(toRateLimit(20, 10)).toBe('20M/10M')
  })

  it('writes a symmetric package in RouterOS shorthand', () => {
    expect(toRateLimit(10, 10)).toBe('10M')
  })

  it('converts gigabits at the right magnitude', () => {
    // Regression: the old threshold was 100_000 kbit, which made 100 Mbps into
    // "1G" and then 1000 Mbps into "10G" - selling 1 Gbps as 10 Gbps.
    expect(toRateLimit(1000, 1000)).toBe('1G')
    expect(toRateLimit(100, 100)).toBe('100M')
    expect(toRateLimit(1, 1)).toBe('1M')
  })

  it('keeps sub-megabit speeds in kilobits', () => {
    expect(toRateLimit(0.5, 0.25)).toBe('500k/250k')
  })

  it('does not invent a number for a missing speed', () => {
    // Reachable only from the lenient preview path; the strict path refuses
    // before this. Here so the fallback stays explicit and visible.
    expect(toRateLimit(null, null)).toBe('unlimited')
  })
})

describe('router object names cannot change what the script means', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeObjectName('Home 5M')).toBe('Home_5M')
    expect(sanitizeObjectName('fiber_100')).toBe('fiber_100')
  })

  it('strips characters that would break out of a RouterOS string', () => {
    expect(sanitizeObjectName('a";b')).toBe('ab')
    expect(sanitizeObjectName('a}b')).toBe('ab')
    expect(sanitizeObjectName('a$b')).toBe('ab')
    expect(sanitizeObjectName("it's")).toBe('its')
  })

  it('flattens a newline rather than letting it end the line', () => {
    // A raw newline in an object name would split the generated script, and the
    // line after it would run as a command.
    expect(sanitizeObjectName('a\nb')).toBe('a_b')
    expect(sanitizeObjectName('a\r\nb')).toBe('a_b')
    expect(sanitizeObjectName('a\tb')).toBe('a_b')
  })

  it('removes the sequences that open and close a RouterOS comment', () => {
    expect(sanitizeObjectName('a/*x*/b')).toBe('axb')
  })

  it('never returns an empty name', () => {
    expect(sanitizeObjectName('')).toBe('plan')
    expect(sanitizeObjectName('***')).toBe('plan')
  })

  it('bounds the length to something a router will accept', () => {
    expect(sanitizeObjectName('x'.repeat(200)).length).toBeLessThanOrEqual(48)
  })

  it('is what actually reaches the profile', () => {
    expect(planProfiles(plan({ name: 'Home\n5M' })).objectName).toBe('Home_5M')
  })
})

describe('what actually reaches a router', () => {
  it('reads the numbers from the database row', () => {
    const p = planProfiles(plan({ speed_down: '20 Mbps', speed_up: '5 Mbps' }))
    expect(p.rateLimit).toBe('20M/5M')
    expect(p.downloadKbps).toBe(20_000)
    expect(p.uploadKbps).toBe(5_000)
  })

  it('follows an edit with no code change', () => {
    // The ISP raised the package from 3 to 20 Mbps in their dashboard. The next
    // sync must write 20, not a value baked in when this was written.
    expect(planProfiles(plan({ speed_down: '3 Mbps' })).rateLimit)
      .not.toBe(planProfiles(plan({ speed_down: '20 Mbps' })).rateLimit)
  })

  it('gives a PPPoE package an address and a HotSpot package none', () => {
    const pool = { local: '10.10.0.2-10.10.0.254', remote: '10.10.1.2-10.10.1.254' }
    expect(planProfiles(plan({ kind: 'pppoe' }), pool).needsPpp).toBe(true)
    expect(planProfiles(plan({ kind: 'pppoe' }), pool).localAddress).toBe(pool.local)
    // A HotSpot subscriber is addressed by the HotSpot server, not a PPP pool.
    expect(planProfiles(plan({ kind: 'hotspot' }), pool).needsPpp).toBe(false)
  })

  it('never carries the price', () => {
    // A price written into a router config survives in exports and backups,
    // readable by anyone who touches the device.
    expect(JSON.stringify(planProfiles(plan({ price: 12_500 }))))
      .not.toMatch(/12500|price/i)
  })
})

describe('a broken package stops the stage instead of shipping unlimited', () => {
  it('throws rather than producing an unlimited rate limit', () => {
    expect(() => planProfilesStrict(plan({ speed_down: 'fast' })))
      .toThrow(ProfileSpeedError)
  })

  it('names the package that is wrong, so the operator can act', () => {
    expect(() => planProfilesStrict(plan({ name: 'Cheap Plan', speed_up: 'quick' })))
      .toThrow(/Cheap Plan/)
  })

  it('catches an unreadable upload speed too', () => {
    expect(() => planProfilesStrict(plan({ speed_up: 'asap' })))
      .toThrow(/upload speed/)
  })

  it('rejects a PPPoE package with no address pool', () => {
    expect(() => planProfilesStrict(plan({ kind: 'pppoe' })))
      .toThrow(/address pool/)
  })

  it('writes nothing when one package in the set is broken', () => {
    // All-or-nothing: four good profiles plus one failure leaves a router
    // matching no package the ISP actually sold.
    expect(() => planProfilesStrictAll([
      plan({ id: 'a' }),
      plan({ id: 'b', name: 'Broken', speed_down: 'unlimited please' }),
      plan({ id: 'c' }),
    ])).toThrow(ProfileSpeedError)
  })

  it('accepts good packages and ignores inactive ones', () => {
    expect(planProfilesStrictAll([
      plan({ id: 'a' }),
      plan({ id: 'b', name: 'Retired', is_active: false }),
    ]).map((p) => p.objectName)).toEqual(['Home_5M'])
  })
})

describe('which packages reach the router', () => {
  it('includes an active package hidden from the storefront', () => {
    // Hidden but real: still sold at the counter and still renewed. A marketing
    // change must not break renewals.
    expect(plansToSync([plan({ name: 'Counter Deal', show_on_portal: false })])
      .map((p) => p.name)).toEqual(['Counter Deal'])
  })

  it('excludes a deactivated package', () => {
    expect(plansToSync([plan({ is_active: false })])).toHaveLength(0)
  })

  it('reports which services the set of plans needs', () => {
    expect(servicesNeeded([plan({ kind: 'hotspot' })]))
      .toEqual({ hotspot: true, pppoe: false })
    expect(servicesNeeded([plan({ kind: 'pppoe' })]))
      .toEqual({ hotspot: false, pppoe: true })
    expect(servicesNeeded([plan({ kind: 'fiber' })]))
      .toEqual({ hotspot: false, pppoe: true })
  })

  it('reports neither service for an empty catalogue', () => {
    expect(servicesNeeded([])).toEqual({ hotspot: false, pppoe: false })
  })
})