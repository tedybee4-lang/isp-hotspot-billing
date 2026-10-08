/**
 * Tests for the provision-engine API client (`src/lib/provisionApi.ts`).
 *
 * The wizard cannot work without this layer, and the engine's login envelope
 * (`{ data: { access_token, ... } }`, form-encoded POST) is the one contract
 * that must never drift: a 200 without the envelope is as broken as a 401.
 * Everything is exercised against a fetch stub — no backend required.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  signIn, hasAuthToken, clearAuthToken, listSessions, ProvisionError,
  waitForScanReport,
} from './provisionApi'
import type { DeviceScan } from './provisionApi'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

beforeEach(() => {
  clearAuthToken()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)))
}

describe('engine sign-in', () => {
  it('stores the JWT from the login envelope and marks itself authed', async () => {
    stubFetch((url) => {
      expect(String(url)).toContain('/api/v1/auth/login')
      return jsonResponse({ data: { access_token: 'tok123', user: { username: 'superuser' } } })
    })
    expect(hasAuthToken()).toBe(false)
    await signIn('superuser@codevertexafrica.com', 'pw')
    expect(hasAuthToken()).toBe(true)
    expect(localStorage.getItem('ispflow.provision.token')).toBe('tok123')
  })

  it('posts form-encoded credentials, the way the OAuth2 login expects', async () => {
    let seen: RequestInit | undefined
    stubFetch((_url, init) => {
      seen = init
      return jsonResponse({ data: { access_token: 'tok123' } })
    })
    await signIn('someone@example.com', 'secret')
    expect(seen?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    const params = new URLSearchParams(String(seen?.body))
    expect(params.get('username')).toBe('someone@example.com')
    expect(params.get('password')).toBe('secret')
  })

  it('rejects loudly when the envelope has no token', async () => {
    stubFetch(() => jsonResponse({ data: {} }))
    await expect(signIn('a', 'b')).rejects.toBeInstanceOf(ProvisionError)
    expect(hasAuthToken()).toBe(false)
  })

  it('surfaces the server detail on bad credentials', async () => {
    stubFetch(() => jsonResponse({ detail: 'Incorrect username or password' }, 401))
    await expect(signIn('a', 'b')).rejects.toThrowError(/Incorrect username or password/)
  })
})

describe('authenticated calls', () => {
  it('sends the Bearer token and parses the session list', async () => {
    let auth = ''
    let calls = 0
    stubFetch((url, init) => {
      calls += 1
      if (String(url).includes('/api/v1/auth/login')) {
        return jsonResponse({ data: { access_token: 'tok123' } })
      }
      auth = String((init?.headers as Record<string, string>).Authorization)
      expect(String(url)).toContain('/api/v1/provisioning/sessions?limit=20')
      return jsonResponse({ sessions: [{ session_id: 's1', router_id: 1, status: 'pending', service_type: 'hotspot', created_at: null, completed_at: null }] })
    })
    // Sign in first: that is the supported path to a bearer token.
    await signIn('a', 'b')
    const sessions = await listSessions()
    expect(calls).toBe(2)
    expect(auth).toBe('Bearer tok123')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].session_id).toBe('s1')
  })

  it('sends anonymous calls when no token and no env creds exist', async () => {
    // The engine accepts anonymous provisioning calls, so a missing token
    // must NOT gate the wizard — the request goes out unauthenticated.
    let auth = ''
    stubFetch((url, init) => {
      expect(String(url)).toContain('/api/v1/provisioning/sessions?limit=20')
      auth = String((init?.headers as Record<string, string>).Authorization)
      return jsonResponse({ sessions: [] })
    })
    const sessions = await listSessions()
    expect(sessions).toEqual([])
    // Sent with an empty bearer (engine resolves it to its system user).
    expect(auth).toBe('Bearer ')
  })

  it('turns a network failure into an engine-unreachable ProvisionError', async () => {
    // "Failed to fetch" (engine down / wrong port / CORS) must surface an
    // actionable message naming the engine URL, not the browser's TypeError.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(listSessions()).rejects.toMatchObject({
      detail: { reason: 'engine-unreachable' },
    })
    await expect(listSessions()).rejects.toThrowError(/Cannot reach the provisioning engine/)
  })
})

/* ── Device scan: waiting for the router's phone-home report ──────────────── */

const SCAN_FIXTURE: DeviceScan = {
  interfaces: ['ether1', 'ether2'],
  wan_interface: 'ether1',
  services: [{ name: 'hotspot', active: false, available: true }],
  network_config: {
    router_ip: '192.168.88.1', router_ip_cidr: '192.168.88.1/24',
    network: '192.168.88.0/24', network_address: '192.168.88.0',
    gateway: '192.168.88.1', broadcast: '192.168.88.255',
    dhcp_start: '192.168.88.2', dhcp_end: '192.168.88.254',
    dhcp_pool: '192.168.88.2 - 192.168.88.254',
    subnet_mask: '255.255.255.0', cidr: 24, total_hosts: 254,
    dns_servers: ['8.8.8.8'], current_subnet: '192.168.88.1/24',
    wan_interface: 'ether1',
  },
  system_info: {
    identity: 'MikroTik', board_name: 'hAP ac2', model: 'hAP ac2',
    version: '7.16.2', architecture: 'arm64', uptime: '1w2d',
  },
  current_subnet: '192.168.88.1/24',
  available_services: ['pppoe'],
}

function statusFixture(over: Record<string, unknown> = {}) {
  return {
    can_use_direct_api: false,
    bootstrap_completed: false,
    provisioning_status: 'pending',
    last_provisioned_at: null,
    agent_installed: false,
    agent_online: false,
    has_cached_scan: false,
    ...over,
  }
}

describe('waitForScanReport', () => {
  beforeEach(async () => {
    clearAuthToken()
    // Token up front so waitForScanReport's fetches are authenticated calls.
    stubFetch((url) => String(url).includes('/api/v1/auth/login')
      ? jsonResponse({ data: { access_token: 'tok123' } })
      : jsonResponse({}))
    await signIn('a', 'b')
  })

  it('returns immediately when the cache is already warm (optimistic read wins)', async () => {
    const probes: string[] = []
    stubFetch((url) => {
      const u = String(url)
      if (u.includes('/auth/login')) return jsonResponse({ data: { access_token: 'tok123' } })
      if (u.includes('/can-use-direct-api/')) {
        probes.push(u)
        // Probe is slower to be asked than the eager read — must not matter.
        return jsonResponse(statusFixture({ has_cached_scan: true }))
      }
      if (u.includes('/device/scan')) return jsonResponse(SCAN_FIXTURE)
      return jsonResponse({})
    })
    const scan = await waitForScanReport(7, { deadlineMs: 500 })
    expect(scan.interfaces).toEqual(['ether1', 'ether2'])
    expect(scan.wan_interface).toBe('ether1')
  })

  it('polls the DB-only probe until the report lands, then reads the cache', async () => {
    let probes = 0
    let scans = 0
    const seenBodies: unknown[] = []
    stubFetch((url, init) => {
      const u = String(url)
      if (u.includes('/auth/login')) return jsonResponse({ data: { access_token: 'tok123' } })
      if (u.includes('/can-use-direct-api/')) {
        probes += 1
        // First two polls: router has not phoned home yet. Third: cached.
        return jsonResponse(statusFixture({ has_cached_scan: probes >= 3 }))
      }
      if (u.includes('/device/scan')) {
        scans += 1
        seenBodies.push(init?.body)
        // The eager attempt (before any report) fails the way a NAT'd
        // direct dial does; the post-probe read succeeds from the cache.
        if (scans === 1) return jsonResponse({ detail: 'No credentials available for router' }, 400)
        return jsonResponse(SCAN_FIXTURE)
      }
      return jsonResponse({})
    })
    const scan = await waitForScanReport(7, {
      deadlineMs: 3000, intervalMs: 25, progressIntervalMs: 10,
    })
    expect(scan.current_subnet).toBe('192.168.88.1/24')
    expect(probes).toBeGreaterThanOrEqual(3)
    expect(scans).toBe(2)
    // Every scan read is non-forcing: the waiter never triggers a direct dial.
    for (const body of seenBodies) {
      expect(JSON.parse(String(body))).toMatchObject({ force_rescan: false })
    }
  })

  it('times out with an actionable message instead of hanging forever', async () => {
    stubFetch((url) => {
      const u = String(url)
      if (u.includes('/auth/login')) return jsonResponse({ data: { access_token: 'tok123' } })
      if (u.includes('/can-use-direct-api/')) return jsonResponse(statusFixture()) // never ready
      if (u.includes('/device/scan')) return jsonResponse({ detail: 'connection timed out' }, 500)
      return jsonResponse({})
    })
    const progress: number[] = []
    await expect(
      waitForScanReport(7, {
        deadlineMs: 80, intervalMs: 10, progressIntervalMs: 0,
        onProgress: (s) => progress.push(s),
      }),
    ).rejects.toMatchObject({
      detail: { reason: 'scan-report-timeout' },
    })
    await expect(
      waitForScanReport(7, { deadlineMs: 40, intervalMs: 10 }),
    ).rejects.toThrowError(/bootstrap/i)
    expect(progress.length).toBeGreaterThan(0)
  })
})
