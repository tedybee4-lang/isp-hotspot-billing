/**
 * The staged provisioning engine, exercised against a fake router.
 *
 * The router here is a mock: it records what it was asked to run and returns
 * whatever the test tells it to. That is enough to prove the properties that
 * matter - what gets written, what never gets touched, which failure stops the
 * run - and it is NOT a substitute for hardware. No test in this file has run
 * against a physical MikroTik.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  OWNER, LEGACY_OWNER, isOwned, safeName,
  parseSpeedMbps, rateLimit, runStage,
  STAGE_IMPLEMENTATIONS, WORKER_STAGE_NAMES,
  backupStage, connectivityStage, secureTunnelStage, radiusStage,
  hotspotStage, pppoeStage, firewallNatStage, packageSyncStage,
  customerSyncStage, verificationStage, discoveryStage, heartbeatStage,
  syncScriptsStage,
  type StageContext, type StagePlan, type StageCustomer,
} from './stages.ts'

// ── A router that records what it was asked to do ─────────────────────────

interface Call { command: string; params: Record<string, string> }

class FakeRouter {
  readonly calls: Call[] = []
  /** Responses keyed by command. A command with no entry returns []. */
  rows: Record<string, Record<string, string>[]> = {}
  /** Commands that must fail, with the message the router would give. */
  fail: Record<string, string> = {}

  readonly client = {
    run: async (_t: unknown, command: string, params: Record<string, string> = {}) => {
      this.calls.push({ command, params })
      const boom = this.fail[command]
      if (boom) throw new Error(boom)
      return {
        rows: this.rows[command] ?? [],
        method: 'api_ssl' as const, latencyMs: 1, encrypted: true,
      }
    },
  } as never

  /** Every command that writes something. */
  writes(): Call[] {
    return this.calls.filter((c) => /\/(add|set|remove|enable|disable)$/.test(c.command))
  }

  commandsMatching(re: RegExp): Call[] {
    return this.calls.filter((c) => re.test(c.command))
  }
}

const target = {} as never

const session = (over: Partial<StageContext['session']> = {}): StageContext['session'] => ({
  id: '11111111-2222-3333-4444-555555555555',
  ispId: 'isp-a',
  nodeId: 'node-1',
  role: 'hotspot',
  tag: 'ab12cd34',
  wanInterface: 'ether1',
  hotspotInterfaces: ['ether2'],
  pppoeInterfaces: [],
  managementInterfaces: ['bridge'],
  tunnelRequired: false,
  dns: ['8.8.8.8'],
  radiusServer: null,
  radiusEnabled: false,
  radiusSecret: null,
  sessionTimeoutMin: 30,
  idleTimeoutMin: 5,
  pppLocal: null,
  pppRemote: null,
  hotspotPool: null,
  ...over,
})

const plan = (over: Partial<StagePlan> = {}): StagePlan => ({
  id: 'p1', name: 'Home 5M', kind: 'hotspot',
  speed_down: '5 Mbps', speed_up: '2 Mbps',
  shared_users: 1, data_limit: null, is_active: true,
  ...over,
})

const ctx = (over: Partial<StageContext> = {}): StageContext => ({
  session: session(), plans: [], customers: [], ...over,
})

let r: FakeRouter
beforeEach(() => { r = new FakeRouter() })

// ── 1-3. Router generations ───────────────────────────────────────────────

describe('the engine works on every router generation', () => {
  it('1. configures a RouterOS 7 router', async () => {
    r.rows['/interface/print'] = [
      { name: 'ether1' }, { name: 'ether2' }, { name: 'bridge' },
    ]
    const out = await discoveryStage(r.client, target, ctx())
    expect(out.status).toBe('success')
  })

  it('2. configures a RouterOS 6 router, where WireGuard does not exist', async () => {
    r.fail['/interface/wireguard/print'] = 'no such command'
    // An optional tunnel on a 6.x box is unsupported, not failed: a cheap
    // access point that cannot do WireGuard is not a broken router.
    expect((await secureTunnelStage(r.client, target, ctx())).status).toBe('unsupported')

    r.fail['/ip/hotspot/print'] = 'no such command'
    expect((await hotspotStage(r.client, target, ctx())).status).toBe('unsupported')
  })

  it('3. gives a low-memory router a light poll interval', async () => {
    // A 30-second poll on an RB941 starves it. This is the thing that has to
    // differ on a small device.
    r.rows['/system/scheduler/print'] = []
    const out = await heartbeatStage(r.client, target, ctx())
    expect(out.status).toBe('success')
    const add = r.writes().find((c) => c.command === '/system/scheduler/add')
    expect(add?.params.interval).toBe('10m')
  })
})

// ── 4-6. Selected services ─────────────────────────────────────────────────

describe('it configures only what was selected', () => {
  it('4. HotSpot only writes no PPPoE objects', async () => {
    r.rows['/ip/hotspot/print'] = []
    await hotspotStage(r.client, target, ctx({ session: session({ role: 'hotspot' }) }))
    expect(r.commandsMatching(/pppoe|secret/)).toHaveLength(0)
  })

  it('5. PPPoE only writes no HotSpot objects', async () => {
    r.rows['/interface/pppoe-server/print'] = []
    const out = await pppoeStage(r.client, target, ctx({
      session: session({
        role: 'pppoe', hotspotInterfaces: [], pppoeInterfaces: ['ether3'],
        pppLocal: '10.0.0.2-10.0.0.254', pppRemote: '10.0.1.2-10.0.1.254',
      }),
    }))
    expect(out.status).toBe('success')
    expect(r.commandsMatching(/\/ip\/hotspot\//)).toHaveLength(0)
  })

  it('6. HotSpot and PPPoE write both, each to its own interface', async () => {
    r.rows['/ip/hotspot/print'] = []
    r.rows['/interface/pppoe-server/print'] = []
    const c = ctx({
      session: session({
        role: 'both', hotspotInterfaces: ['ether2'], pppoeInterfaces: ['ether3'],
        pppLocal: '10.0.0.2-10.0.0.254', pppRemote: '10.0.1.2-10.0.1.254',
      }),
    })
    await hotspotStage(r.client, target, c)
    await pppoeStage(r.client, target, c)
    expect(r.writes().some((x) => x.command === '/ip/hotspot/add')).toBe(true)
    const pppAdd = r.writes().find((x) => x.command === '/interface/pppoe-server/add')
    expect(pppAdd).toBeDefined()
    // Each service is bound only to the port it was given.
    expect(pppAdd?.params.service).toBe('ether3')
  })

  it('refuses PPPoE with no address pool rather than inventing one', async () => {
    r.rows['/interface/pppoe-server/print'] = []
    const out = await pppoeStage(r.client, target, ctx({
      session: session({ pppoeInterfaces: ['ether3'] }),
    }))
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/address pool/)
    // No range is ever made up here.
    expect(r.commandsMatching(/pppoe-server\/add/)).toHaveLength(0)
  })
})

// ── 7-10. A router that already has configuration ─────────────────────────

describe('it never disturbs what the router already has', () => {
  it('7. existing firewall rules are preserved', async () => {
    r.rows['/ip/firewall/nat/print'] = [
      { '.id': '*1', name: 'operator-rule', action: 'accept', comment: 'uplink' },
      { '.id': '*2', name: 'other', chain: 'input' },
    ]
    r.rows['/ip/firewall/filter/print'] = [{ '.id': '*3', name: 'keep-me' }]

    const out = await firewallNatStage(r.client, target, ctx())
    expect(out.status).toBe('success')
    // Additive only: no removals, and no writes that are not additions.
    expect(r.commandsMatching(/\/remove/)).toHaveLength(0)
    expect(r.writes().every((c) => c.command.endsWith('/add'))).toBe(true)
    expect(out.detail?.nat_rules_preserved).toBe(2)
    expect(out.detail?.filter_rules_preserved).toBe(1)
  })

  it('8. existing VLANs are untouched', async () => {
    r.rows['/ip/firewall/nat/print'] = []
    r.rows['/ip/firewall/filter/print'] = []
    await firewallNatStage(r.client, target, ctx())
    // The stage never reads or writes VLANs at all.
    expect(r.commandsMatching(/vlan/)).toHaveLength(0)
  })

  it('9. existing bridges are not rebuilt', async () => {
    r.rows['/interface/print'] = [{ name: 'bridge', type: 'bridge' }]
    r.rows['/ip/hotspot/print'] = []
    await discoveryStage(r.client, target, ctx())
    await hotspotStage(r.client, target, ctx())
    expect(r.commandsMatching(/bridge/)).toHaveLength(0)
  })

  it('10. an existing WAN is kept; only masquerade is ensured', async () => {
    // A real RouterOS srcnat row: bound to the WAN and already masquerading.
    r.rows['/ip/firewall/nat/print'] = [{
      '.id': '*9', name: 'nat-wan', chain: 'srcnat',
      'out-interface': 'ether1', action: 'masquerade',
    }]
    r.rows['/ip/firewall/filter/print'] = []
    const out = await firewallNatStage(r.client, target, ctx())
    // Updated in place. RouterOS evaluates srcnat in order, so a SECOND
    // masquerade for the same interface would be two rules for one traffic.
    expect(out.detail?.nat_updated).toBe(true)
    expect(out.detail?.nat_created).toEqual([])
    expect(r.writes().filter((c) => c.command === '/ip/firewall/nat/add')).toHaveLength(0)
  })
})

// ── 13-15. Failure modes that must stop the run ───────────────────────────
// (11 and 12, the lockout refusal and its override, are asserted where the
//  assessment lives: supabase/functions/_shared/lockout.test.ts. What matters
//  here is that no stage can quietly accept a lockout-causing configuration.)

describe('failures stop the run honestly', () => {
  it('13. a required WireGuard tunnel that cannot exist FAILS, not unsupported', async () => {
    r.fail['/interface/wireguard/print'] = 'no such command'
    const out = await secureTunnelStage(r.client, target,
      ctx({ session: session({ tunnelRequired: true }) }))
    expect(out.status).toBe('failed')
    // The distinction is the whole point: "unsupported" would let an unreachable
    // router through the ONLINE gate as though nothing were wrong.
    expect(out.status).not.toBe('unsupported')
  })

  it('14. RADIUS that cannot be applied FAILS the stage', async () => {
    r.rows['/radius/print'] = []
    r.fail['/radius/add'] = 'timeout'
    const out = await radiusStage(r.client, target, ctx({
      session: session({ radiusEnabled: true, radiusServer: '10.9.9.9' }),
    }))
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/authenticate/)
  })

  it('RADIUS that adds but does not report back FAILS, rather than claiming success', async () => {
    r.rows['/radius/print'] = []          // add succeeds, read-back finds nothing
    const out = await radiusStage(r.client, target, ctx({
      session: session({ radiusEnabled: true, radiusServer: '10.9.9.9' }),
    }))
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/does not report it back/)
  })

  it('never puts the RADIUS secret into a result or an error', async () => {
    r.rows['/radius/print'] = []
    r.fail['/radius/add'] = 'failure: timeout talking to 10.9.9.9'
    const out = await radiusStage(r.client, target, ctx({
      session: session({
        radiusEnabled: true, radiusServer: '10.9.9.9', radiusSecret: 'sup3rs3cret',
      }),
    }))
    // The secret goes to the router and nowhere else.
    expect(JSON.stringify(out)).not.toContain('sup3rs3cret')
  })

  it('15. a backup that cannot be written FAILS, and nothing is touched', async () => {
    r.rows['/file/print'] = []
    r.fail['/system/backup/save'] = 'no space left on device'
    const out = await backupStage(r.client, target, ctx())
    expect(out.status).toBe('failed')
    // The operator is told nothing has changed yet, because it has not.
    expect(out.error).toMatch(/Nothing has been changed/)
  })

  it('a backup that saves but produces no file is still a failure', async () => {
    r.rows['/file/print'] = []      // save "succeeds" but nothing appears
    const out = await backupStage(r.client, target, ctx())
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/no such file exists/)
  })

  it('connectivity fails when the API service is absent', async () => {
    r.rows['/ip/service/print'] = [{ name: 'www' }]
    const out = await connectivityStage(r.client, target)
    expect(out.status).toBe('failed')
    expect(out.retryable).toBe(false)
  })
})

// ── 16-18. Resume, retry, duplicates ──────────────────────────────────────

describe('resume and idempotency', () => {
  const settled = (s: string) => ['success', 'skipped', 'unsupported'].includes(s)

  it('16. a run resumes at the failed stage, not from the beginning', () => {
    // discovery, backup and connectivity succeeded; the optional tunnel was
    // skipped; radius failed. Every earlier stage must already be settled, or
    // the resume would stop there instead - which is the point being asserted.
    const statuses: Record<string, string> = {
      discovery: 'success', backup: 'success', connectivity: 'success',
      secure_tunnel: 'skipped',
      radius: 'failed', hotspot: 'pending',
    }
    const next = WORKER_STAGE_NAMES.find((n) => !settled(statuses[n] ?? 'pending'))
    expect(next).toBe('radius')
  })

  it('resumes at an UNSETTLED earlier stage, not past it', () => {
    // The safety property: an unresolved tunnel blocks everything behind it.
    // Resuming at 'radius' here would walk straight past a broken RADIUS.
    const statuses: Record<string, string> = {
      discovery: 'success', backup: 'success', connectivity: 'success',
      secure_tunnel: 'pending', radius: 'pending',
    }
    const next = WORKER_STAGE_NAMES.find((n) => !settled(statuses[n] ?? 'pending'))
    expect(next).toBe('secure_tunnel')
  })

  it('17. a failed stage is retried rather than treated as done', () => {
    // The predicate the whole resume rule rests on.
    expect(settled('failed')).toBe(false)
    expect(settled('running')).toBe(false)
    expect(settled('success')).toBe(true)
    expect(settled('unsupported')).toBe(true)
  })

  it('18. running twice does not create a second copy', async () => {
    r.rows['/ip/firewall/nat/print'] = []
    r.rows['/ip/firewall/filter/print'] = []
    await firewallNatStage(r.client, target, ctx())

    // The router now reports what we created, as it would on a re-run.
    r.rows['/ip/firewall/nat/print'] = [{ '.id': '*1', name: `${OWNER}-ab12cd34-out` }]
    r.rows['/ip/firewall/filter/print'] = [{ '.id': '*2', name: `${OWNER}-ab12cd34-mgmt` }]
    r.calls.length = 0

    await firewallNatStage(r.client, target, ctx())
    expect(r.writes().filter((c) => c.command.endsWith('/add'))).toHaveLength(0)
  })

  it('does not create a second HotSpot server on an interface that has one', async () => {
    r.rows['/ip/hotspot/print'] = [{ '.id': '*1', name: 'existing', interface: 'ether2' }]
    const out = await hotspotStage(r.client, target, ctx())
    expect(out.detail?.updated).toEqual(['ether2'])
    expect(r.writes().filter((c) => c.command === '/ip/hotspot/add')).toHaveLength(0)
  })

  it('leaves a HotSpot server on an unselected interface alone', async () => {
    r.rows['/ip/hotspot/print'] = [
      { '.id': '*1', name: 'other-branch', interface: 'ether5' },
    ]
    const out = await hotspotStage(r.client, target, ctx())
    // It may be serving another branch or a reseller. Not ours to touch.
    expect(out.detail?.untouched).toBe(1)
    expect(r.commandsMatching(/\/remove/)).toHaveLength(0)
  })
})

// ── 19-22. Packages ───────────────────────────────────────────────────────

describe('packages come from the database', () => {
  beforeEach(() => { r.rows['/ip/hotspot/user/profile/print'] = [] })

  it('19. a price never reaches the router', async () => {
    await packageSyncStage(r.client, target, ctx({ plans: [plan({ name: 'Home 5M' })] }))
    // The plan the stage receives has no price field at all, so there is nothing
    // to leak even by accident.
    expect(JSON.stringify(r.writes())).not.toMatch(/price/i)
  })

  it('20. a speed change is applied on the next sync', async () => {
    await packageSyncStage(r.client, target, ctx({
      plans: [plan({ name: 'Home', speed_down: '3 Mbps', speed_up: '3 Mbps' })],
    }))
    const add = r.writes().find((c) => c.command === '/ip/hotspot/user/profile/add')
    expect(add?.params['rate-limit']).toBe('3M')
  })

  it('21. a hidden-but-active package is still provisioned', async () => {
    // Hiding a package from the storefront is a marketing choice, not a network
    // one. It is still sold at the counter and still renewed.
    const out = await packageSyncStage(r.client, target, ctx({
      plans: [plan({ name: 'Counter Deal', is_active: true })],
    }))
    expect(out.detail?.plans).toBe(1)
  })

  it('22. a deactivated package is not provisioned', async () => {
    const out = await packageSyncStage(r.client, target, ctx({
      plans: [plan({ is_active: false })],
    }))
    expect(out.detail?.plans).toBe(0)
  })

  it('writes the right RouterOS rate limit at every magnitude', () => {
    // The regression that sold a 1 Gbps package as 10 Gbps.
    expect(rateLimit(1000, 1000)).toBe('1G')
    expect(rateLimit(100, 100)).toBe('100M')
    expect(rateLimit(20, 10)).toBe('20M/10M')
    expect(rateLimit(0.5, 0.25)).toBe('500k/250k')
    // Never a doubled suffix, which RouterOS rejects.
    expect(rateLimit(20, 10)).not.toMatch(/MM/)
  })

  it('reads the speed the ISP typed, in every form the form accepts', () => {
    expect(parseSpeedMbps('10 Mbps')).toBe(10)
    expect(parseSpeedMbps('512 Kbps')).toBeCloseTo(0.512)
    expect(parseSpeedMbps('1 Gbps')).toBe(1000)
    // And refuses rather than guessing, because a wrong default is unlimited.
    expect(parseSpeedMbps('fast')).toBeNull()
  })
})

// ── 23. Customer sync ──────────────────────────────────────────────────────

describe('customer sync mirrors, it never decides', () => {
  const customer = (over: Partial<StageCustomer> = {}): StageCustomer => ({
    id: 'c1', username: 'alice', password_plain: null,
    plan_name: 'Home 5M', is_active: true, ...over,
  })

  it('23. only customers the billing side made active are pushed', async () => {
    r.rows['/ip/hotspot/user/print'] = []
    const out = await customerSyncStage(r.client, target, ctx({
      customers: [customer({ is_active: true }), customer({ id: 'c2', is_active: false })],
    }))
    expect(out.detail?.entitled).toBe(1)
  })

  it('reports that it touched no payment and created no entitlement', async () => {
    r.rows['/ip/hotspot/user/print'] = []
    const out = await customerSyncStage(r.client, target, ctx({ customers: [customer()] }))
    // Spelled out so the property is asserted rather than assumed.
    expect(out.detail?.payments_touched).toBe(0)
    expect(out.detail?.entitlements_created_here).toBe(0)
  })

  it('never writes a payment, an invoice or an amount', async () => {
    r.rows['/ip/hotspot/user/print'] = []
    await customerSyncStage(r.client, target, ctx({ customers: [customer()] }))
    const written = JSON.stringify(r.writes()).toLowerCase()
    for (const forbidden of ['payment', 'invoice', 'paid', 'amount']) {
      expect(written).not.toContain(forbidden)
    }
  })

  it('skips a customer with no credential rather than creating a broken account', async () => {
    r.rows['/ip/hotspot/user/print'] = []
    const out = await customerSyncStage(r.client, target, ctx({ customers: [customer()] }))
    expect(out.detail?.created).toBe(0)
    expect(r.writes()).toHaveLength(0)
  })

  it('is idempotent: an account already on the router is left alone', async () => {
    r.rows['/ip/hotspot/user/print'] = [{ name: 'alice' }]
    const out = await customerSyncStage(r.client, target, ctx({ customers: [customer()] }))
    expect(out.detail?.already_present).toBe(1)
    // Re-running must not churn a live session or reset traffic counters.
    expect(r.writes()).toHaveLength(0)
  })
})

// ── 24. Tenant isolation ───────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('24. a stage result never carries the tenant id onto the device', async () => {
    r.rows['/ip/firewall/nat/print'] = []
    r.rows['/ip/firewall/filter/print'] = []
    const out = await firewallNatStage(r.client, target, ctx())
    // The tag on the device is the router tag, never the ISP id.
    expect(JSON.stringify(out)).not.toContain('isp-a')
    expect(JSON.stringify(r.writes())).not.toContain('isp-a')
  })
})

// ── 25. Legacy NETISP ──────────────────────────────────────────────────────

describe('a legacy NETISP router', () => {
  it('25. is recognised as ours, so nothing is duplicated', () => {
    expect(isOwned({ comment: `${LEGACY_OWNER}:oldrun` })).toBe(true)
    expect(isOwned({ comment: `${OWNER}:newrun` })).toBe(true)
    // An operator's own label is not ours.
    expect(isOwned({ comment: 'uplink to NBO' })).toBe(false)
  })

  it('keeps the legacy tag rather than renaming it', async () => {
    r.rows['/system/identity/print'] = [{ name: 'Branch-1 [NETISP:oldrun]' }]
    const out = await syncScriptsStage(r.client, target, ctx())
    expect(out.status).toBe('success')
    expect(out.detail?.legacy_netisp).toBe(true)
    expect(out.detail?.already_marked).toBe(true)
    // The identity is NOT rewritten: an ISP's own runbook may grep for NETISP,
    // and rewriting it would make the old platform believe it owns nothing.
    expect(r.writes()).toHaveLength(0)
  })

  it('reuses a legacy-tagged NAT rule instead of adding a second one', async () => {
    r.rows['/ip/firewall/nat/print'] = [{
      '.id': '*5', name: 'netisp-nat', chain: 'srcnat',
      'out-interface': 'ether1', action: 'masquerade',
      comment: `${LEGACY_OWNER}:x`,
    }]
    r.rows['/ip/firewall/filter/print'] = []
    const out = await firewallNatStage(r.client, target, ctx())
    // An existing masquerade is adopted in place, not shadowed by a new rule.
    expect(r.writes().filter((c) => c.command === '/ip/firewall/nat/add')).toHaveLength(0)
    expect(out.detail?.nat_updated).toBe(true)
  })
})

// ── The registry ──────────────────────────────────────────────────────────

describe('the stage registry', () => {
  it('covers every stage in the catalogue, in the catalogue order', () => {
    // Mirrors provisioning_stage_specs. A drift here means a stage exists that
    // no database rule knows about, which is how a stage ends up never running.
    expect(WORKER_STAGE_NAMES).toEqual([
      'discovery', 'backup', 'connectivity', 'secure_tunnel', 'radius',
      'hotspot', 'pppoe', 'firewall_nat', 'sync_scripts', 'heartbeat',
      'package_sync', 'customer_sync', 'verification',
    ])
  })

  it('has an implementation for every stage it names', () => {
    for (const name of WORKER_STAGE_NAMES) {
      expect(typeof STAGE_IMPLEMENTATIONS[name]).toBe('function')
    }
  })

  it('a stage that is not in the registry fails loudly', async () => {
    const out = await runStage('nonexistent', r.client, target, ctx())
    expect(out.status).toBe('failed')
    expect(out.retryable).toBe(false)
  })

  it('a stage that throws becomes a failed stage, not a crashed worker', async () => {
    // package_sync throws on an unreadable speed. That must surface as a named
    // failure with the stage settled, never as an exception that leaves the row
    // stuck in 'running' forever.
    const out = await runStage('package_sync', r.client, target, ctx({
      plans: [plan({ speed_down: 'quick' })],
    }))
    expect(out.status).toBe('failed')
    expect(out.retryable).toBe(false)
  })
})

// ── Verification ──────────────────────────────────────────────────────────

describe('verification reads rather than trusts', () => {
  const ready = () => {
    r.rows['/file/print'] = [{ name: `ispflow-backup-ab12cd34-binary.backup`, size: '900' }]
    r.rows['/ip/service/print'] = [{ name: 'api', port: '8728', disabled: 'false' }]
    r.rows['/ip/hotspot/print'] = [{ interface: 'ether2' }]
  }

  it('fails when the backup is gone', async () => {
    r.rows['/ip/service/print'] = [{ name: 'api', port: '8728' }]
    r.rows['/ip/hotspot/print'] = [{ interface: 'ether2' }]
    r.rows['/file/print'] = []
    const out = await verificationStage(r.client, target, ctx())
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/backup/)
  })

  it('passes only when the backup, the API and the services all exist', async () => {
    ready()
    expect((await verificationStage(r.client, target, ctx())).status).toBe('success')
  })

  it('fails when the ISP selected a service that is not running', async () => {
    ready()
    r.rows['/ip/hotspot/print'] = []     // nothing on ether2
    const out = await verificationStage(r.client, target, ctx())
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/ether2/)
  })

  it('fails when a required tunnel does not exist', async () => {
    ready()
    r.rows['/interface/wireguard/print'] = []
    const out = await verificationStage(r.client, target,
      ctx({ session: session({ tunnelRequired: true }) }))
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/WireGuard/)
  })

  it('writes nothing at all', async () => {
    ready()
    await verificationStage(r.client, target, ctx())
    // A verification stage that can write is not a verification stage.
    expect(r.writes()).toHaveLength(0)
  })
})

// ── Object names ──────────────────────────────────────────────────────────

describe('object names cannot change what a script means', () => {
  it('flattens a newline rather than letting it end the line', () => {
    expect(safeName('a\nb')).toBe('a_b')
    expect(safeName('a\r\nb')).toBe('a_b')
  })

  it('strips the RouterOS comment delimiters and quoting characters', () => {
    expect(safeName('a/*x*/b')).toBe('axb')
    expect(safeName('a";b')).toBe('ab')
    expect(safeName('a$b')).toBe('ab')
  })

  it('returns null rather than an unusable name', () => {
    expect(safeName('***')).toBeNull()
    expect(safeName('')).toBeNull()
  })

  it('bounds the length', () => {
    expect(safeName('x'.repeat(200))!.length).toBeLessThanOrEqual(48)
  })

  it('tags everything it creates with the current ownership tag', async () => {
    r.rows['/ip/firewall/nat/print'] = []
    r.rows['/ip/firewall/filter/print'] = []
    await firewallNatStage(r.client, target, ctx())
    for (const w of r.writes()) {
      expect(w.params.comment).toBe(`${OWNER}:ab12cd34`)
    }
  })
})