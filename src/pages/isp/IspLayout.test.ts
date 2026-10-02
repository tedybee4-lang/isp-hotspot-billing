import { describe, expect, it } from 'vitest'
import { isRouterOnline, countLiveRouters } from './IspLayout'
import type { Node } from '../../lib/types'

/**
 * The liveness rule the sidebar and the Network Status page share.
 *
 * This is the single most consequential line of logic in the panel: if a dead
 * router counts as online, an ISP is told their network is up while customers
 * cannot connect, and they will look at the wrong thing for hours.
 */
const NOW = Date.parse('2026-01-15T12:00:00Z')

function node(over: Partial<Node> = {}): Node {
  return {
    id: 'n1', isp_id: 'i1', name: 'Branch router', host: '10.0.0.1',
    model: null, os_version: null, serial_number: null, routeros_version: null,
    status: 'online', active_users: 0, load_percent: 0, capacity: null,
    cpu_load: null, ram_used_mb: null, ram_total_mb: null, uptime_seconds: null,
    notes: null, last_seen: new Date(NOW - 10_000).toISOString(),
    api_port: 8728, enabled: true, poll_interval_secs: 60,
    last_poll_at: null, last_error: null, last_latency_ms: null,
    ...over,
  }
}

describe('isRouterOnline', () => {
  it('is true just after a heartbeat', () => {
    expect(isRouterOnline(new Date(NOW - 10_000).toISOString(), 60, NOW)).toBe(true)
  })

  it('is false once the threshold passes, even if status says online', () => {
    // The bug this prevents: a stored `status: 'online'` surviving a crash and
    // keeping a dead router green in the sidebar forever.
    const stale = new Date(NOW - 600_000).toISOString()
    expect(isRouterOnline(stale, 60, NOW)).toBe(false)
    expect(node({ status: 'online', last_seen: stale }).status).toBe('online')
  })

  it('is false with no heartbeat at all', () => {
    expect(isRouterOnline(null, 60, NOW)).toBe(false)
  })

  it('scales the threshold with the poll interval', () => {
    const beat = new Date(NOW - 200_000).toISOString()
    // A router polled every 10s has gone quiet well before one polled every 60s.
    expect(isRouterOnline(beat, 10, NOW)).toBe(false)
    expect(isRouterOnline(beat, 120, NOW)).toBe(true)
  })

  it('treats a zero or missing interval as the 60-second default', () => {
    const beat = new Date(NOW - 30_000).toISOString()
    expect(isRouterOnline(beat, 0, NOW)).toBe(true)
    expect(isRouterOnline(new Date(NOW - 240_000).toISOString(), 0, NOW)).toBe(false)
  })

  it('tolerates clock skew without calling a dead router alive', () => {
    // A beat stamped in the future is skew. Clamping means a router that
    // stopped beating is never kept online by a bad clock.
    const future = new Date(NOW + 3_600_000).toISOString()
    expect(isRouterOnline(future, 60, NOW)).toBe(true)
    expect(isRouterOnline(new Date(NOW - 3_600_000).toISOString(), 60, NOW)).toBe(false)
  })

  it('rejects an unparseable timestamp instead of assuming a live router', () => {
    expect(isRouterOnline('not-a-date', 60, NOW)).toBe(false)
  })
})

describe('countLiveRouters', () => {
  it('counts only routers that are actually beating', () => {
    const nodes = [
      node({ id: 'a' }),
      node({ id: 'b', last_seen: new Date(NOW - 5 * 60_000).toISOString() }),
      node({ id: 'c', last_seen: null }),
      node({ id: 'd', last_seen: new Date(NOW - 60_000).toISOString() }),
    ]
    // 'b' and 'c' both carry status 'online' and neither is really there.
    expect(countLiveRouters(nodes, NOW)).toBe(2)
  })

  it('is zero for an empty fleet rather than undefined', () => {
    expect(countLiveRouters([], NOW)).toBe(0)
  })
})