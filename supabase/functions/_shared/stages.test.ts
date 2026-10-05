/**
 * The stage machine: ordering, resume, and the ONLINE gate.
 *
 * The properties asserted here are the ones that decide whether a router is
 * allowed to serve paying customers. Two are safety rules tightened during
 * review - a required-but-impossible WireGuard tunnel, and an
 * optionally-required service the ISP explicitly chose - and those tests exist
 * to stop a later edit quietly relaxing them.
 */
import { describe, expect, it } from 'vitest'
import {
  STAGES, STAGE_NAMES, isSettled, canStart, nextStage,
  onlineBlocker, progressOf, initialStatuses,
  type StageStatus,
} from './stages.ts'

const settled = (over: Partial<Record<string, StageStatus>> = {}) =>
  Object.fromEntries([
    ...STAGE_NAMES.map((n) => [n, 'success' as StageStatus]),
    ...Object.entries(over),
  ]) as Record<string, StageStatus>

describe('the stage list is ordered and unique', () => {
  it('holds every stage exactly once', () => {
    expect(new Set(STAGE_NAMES).size).toBe(STAGE_NAMES.length)
    expect(STAGE_NAMES.length).toBeGreaterThan(0)
  })

  it('puts the backup before anything that changes the router', () => {
    // Backup last would mean a router could be configured with no way back.
    expect(STAGE_NAMES.indexOf('backup')).toBeLessThan(STAGE_NAMES.indexOf('connectivity'))
    expect(STAGE_NAMES.indexOf('backup')).toBeLessThan(STAGE_NAMES.indexOf('radius'))
  })

  it('runs verification last', () => {
    expect(STAGE_NAMES[STAGE_NAMES.length - 1]).toBe('verification')
  })
})

describe('settled states', () => {
  it('counts success, skipped and unsupported as settled', () => {
    expect(isSettled('success')).toBe(true)
    expect(isSettled('skipped')).toBe(true)
    expect(isSettled('unsupported')).toBe(true)
  })

  it('does not count pending or running, and never counts failed', () => {
    expect(isSettled('pending')).toBe(false)
    expect(isSettled('running')).toBe(false)
    // Failed is terminal but NOT settled: it must keep blocking.
    expect(isSettled('failed')).toBe(false)
  })
})

describe('a stage cannot start before the ones before it', () => {
  it('allows the first stage to start on an empty session', () => {
    expect(canStart('discovery', {})).toEqual({ ok: true })
  })

  it('blocks the second stage when the first has not run', () => {
    const r = canStart('backup', { discovery: 'pending' })
    expect(r.ok).toBe(false)
    expect(r.blockedBy).toBe('discovery')
  })

  it('allows progress once every earlier stage is settled', () => {
    expect(canStart('backup', { discovery: 'success' })).toEqual({ ok: true })
  })

  it('is not fooled by an unsupported earlier stage', () => {
    // A RouterOS 6 box has no WireGuard. That must not stop everything after it.
    expect(canStart('radius', {
      discovery: 'success', backup: 'success',
      connectivity: 'success', secure_tunnel: 'unsupported',
    })).toEqual({ ok: true })
  })

  it('rejects a stage that is not in the list at all', () => {
    expect(canStart('not_a_stage', settled()).ok).toBe(false)
  })
})

describe('resuming picks up where the run stopped', () => {
  it('returns the first unsettled stage', () => {
    // backup failed, so a resume must address it - not the stage after it.
    expect(nextStage(settled({ backup: 'failed', connectivity: 'success' }))).toBe('backup')
  })

  it('returns null when everything has settled', () => {
    expect(nextStage(settled())).toBeNull()
  })

  it('treats a run that stopped mid-stage as needing that stage', () => {
    expect(nextStage(settled({ discovery: 'success', backup: 'running' }))).toBe('backup')
  })

  it('lets a resume re-run the failed stage and everything after it', () => {
    // Only after the failed stage itself is retried successfully.
    expect(canStart('radius', settled({
      discovery: 'success', backup: 'success', connectivity: 'failed',
    }))).toEqual({ ok: false, blockedBy: 'connectivity' })

    const retried = settled({
      discovery: 'success', backup: 'success', connectivity: 'success',
    })
    expect(canStart('radius', retried)).toEqual({ ok: true })
    expect(canStart('verification', retried)).toEqual({ ok: true })
  })
})

describe('the ONLINE gate blocks on evidence, not on progress', () => {
  it('refuses a router whose stages are all still pending', () => {
    const b = onlineBlocker({})
    expect(b).not.toBeNull()
    expect(b!.stage).toBe('discovery')
  })

  it('refuses a router where a required stage failed', () => {
    expect(onlineBlocker(settled({ radius: 'failed' }))!.stage).toBe('radius')
  })

  it('refuses a router that is configured but never verified', () => {
    // Every other stage succeeded. This still must not go online.
    expect(onlineBlocker(settled({ verification: 'pending' }))!.stage)
      .toBe('verification')
  })

  it('refuses when verification is unsupported or merely skipped', () => {
    // "Settled" is not "passed". An unverified router must never go online.
    expect(onlineBlocker(settled({ verification: 'unsupported' }))).not.toBeNull()
    expect(onlineBlocker(settled({ verification: 'skipped' }))).not.toBeNull()
  })

  it('refuses a router with no backup taken', () => {
    expect(onlineBlocker(settled({ backup: 'skipped' }))!.stage).toBe('backup')
  })

  it('refuses a running stage even when every other required stage passed', () => {
    expect(onlineBlocker(settled({ radius: 'running' }))).not.toBeNull()
  })

  it('allows a fully settled, verified, backed-up router through', () => {
    expect(onlineBlocker(settled())).toBeNull()
  })

  it('allows an optional unsupported stage through', () => {
    expect(onlineBlocker(settled({ secure_tunnel: 'unsupported' }))).toBeNull()
  })

  it('blocks a failed stage the ISP explicitly selected, even when optional', () => {
    // HotSpot is optional by default. On a router bought to serve HotSpot it is
    // required, and a failed HotSpot stage must not be waved through.
    const s = settled({ hotspot: 'failed', pppoe: 'skipped' })
    expect(onlineBlocker(s)).toBeNull()
    expect(onlineBlocker(s, ['hotspot'])!.stage).toBe('hotspot')
  })
})

describe('initial status reflects what the box can actually do', () => {
  it('records discovery as done, because the router already reported', () => {
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: false, tunnelRequired: false,
    }).discovery).toBe('success')
  })

  it('skips the service the ISP did not choose rather than leaving it pending', () => {
    // A PPPoE stage stuck at pending would block everything behind it forever.
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: false, tunnelRequired: false,
    }).pppoe).toBe('skipped')
  })

  it('marks a WireGuard tunnel unsupported when optional and unavailable', () => {
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: false, tunnelRequired: false,
    }).secure_tunnel).toBe('unsupported')
  })

  it('FAILS when the tunnel is required but the firmware cannot do it', () => {
    // SAFETY: reporting this as "unsupported" would call an unreachable router
    // healthy and let it through the ONLINE gate.
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: false, tunnelRequired: true,
    }).secure_tunnel).toBe('failed')
  })

  it('leaves the tunnel pending when required and possible', () => {
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: true, tunnelRequired: true,
    }).secure_tunnel).toBe('pending')
  })

  it('skips the tunnel when possible but not wanted', () => {
    expect(initialStatuses({
      role: 'hotspot', wireguardSupported: true, tunnelRequired: false,
    }).secure_tunnel).toBe('skipped')
  })
})

describe('progress reporting', () => {
  it('reports zero for an untouched session', () => {
    expect(progressOf({})).toEqual({ total: STAGE_NAMES.length, settled: 0, percent: 0 })
  })

  it('reaches one hundred only when every stage has settled', () => {
    const p = progressOf(settled())
    expect(p.settled).toBe(STAGE_NAMES.length)
    expect(p.percent).toBe(100)
  })

  it('does not count a failed stage as progress', () => {
    // Every stage attempted is not 100%. This number must mean finished.
    expect(progressOf(settled({ radius: 'failed' })).settled)
      .toBe(STAGE_NAMES.length - 1)
  })
})

// The database keeps its own copy of this list so the ONLINE gate holds even if
// the edge function is down. If the two drift, the gate and the panel disagree
// about what is required, which is the exact failure the duplication was meant
// to prevent.
describe('the SQL stage catalogue matches this module', () => {
  it('has the same stages in the same order', () => {
    expect([
      'discovery', 'backup', 'connectivity', 'secure_tunnel', 'radius', 'hotspot',
      'pppoe', 'firewall_nat', 'sync_scripts', 'heartbeat', 'package_sync',
      'customer_sync', 'verification',
    ]).toEqual(STAGE_NAMES)
  })

  it('marks the same stages required', () => {
    const sqlRequired = new Set([
      'discovery', 'backup', 'connectivity', 'radius', 'firewall_nat',
      'sync_scripts', 'heartbeat', 'package_sync', 'verification',
    ])
    for (const { stage, required } of STAGES) {
      expect(sqlRequired.has(stage), `${stage} required-ness differs`).toBe(required)
    }
  })
})