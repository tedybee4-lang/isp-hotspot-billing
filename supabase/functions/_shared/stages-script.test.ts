/**
 * The generated RouterOS: properties a live router has to obey.
 *
 * These scripts run, as root, on a router that may already be carrying paying
 * customers. A syntax error does not merely fail onboarding - it stops partway
 * through, on live hardware, with a half-applied configuration. So these assert
 * the shape of the RouterOS rather than that a function returns a string.
 *
 * Nothing here talks to a router. What has and has not been verified against
 * real hardware is recorded in the commit message; it has not.
 */
import { describe, expect, it } from 'vitest'
import {
  OWNER, isOwned, q, tagComment,
  buildBackupScript, buildConnectivityScript, buildProfileScript,
  buildHeartbeatScript, buildVerifyScript,
} from './stages-script.ts'

describe('ownership marks', () => {
  it('recognises objects this platform created', () => {
    expect(isOwned('ISPFlow:ab12')).toBe(true)
    expect(isOwned('ISPFlow ab12')).toBe(true)
  })

  it('still recognises the legacy NETISP mark', () => {
    // Routers provisioned by an earlier release carry NETISP on every object.
    // Stopping here would make this platform think it owns nothing and create a
    // second copy of everything.
    expect(isOwned('NETISP:ab12')).toBe(true)
  })

  it('does not claim an object an operator labelled themselves', () => {
    expect(isOwned('uplink to NBO')).toBe(false)
    expect(isOwned(null)).toBe(false)
    expect(isOwned('')).toBe(false)
  })
})

describe('quoting for RouterOS string literals', () => {
  it('wraps a value and escapes a quote inside it', () => {
    expect(q('Home 5M')).toBe('"Home 5M"')
    expect(q('a"b')).toBe('"a\\"b"')
  })

  it('escapes a backslash so it cannot escape the quote that follows', () => {
    expect(q('a\\"b')).toBe('"a\\\\\\"b"')
  })
})

describe('the backup stage', () => {
  const script = buildBackupScript({ tag: 'ab12cd34' })

  it('takes a binary backup, which is the one that can be restored', () => {
    expect(script).toMatch(/system backup save/)
  })

  it('takes a text export with secrets hidden', () => {
    // An export without hide-sensitive puts every PPPoE and RADIUS secret into
    // a file meant to be compared or attached to a ticket.
    expect(script).toMatch(/export hide-sensitive/)
  })

  it('does not password-protect the backup', () => {
    // RouterOS would encrypt it with a secret this platform would then have to
    // hold, and a backup nobody can decrypt is not a backup.
    expect(script).not.toMatch(/password=/)
  })

  it('writes to the router rather than uploading anywhere', () => {
    expect(script).not.toMatch(/tool fetch|url=/)
    expect(script).toMatch(/file=/)
  })

  it('names the files after the session so two runs cannot collide', () => {
    expect(script).toMatch(/ispflow-backup-ab12cd34/)
  })
})

describe('the connectivity stage', () => {
  it('does not ask a RouterOS 6 box for a service that does not exist', () => {
    // REST arrived in 7.1. Asking a 6.x box to start www-ssl aborts the import
    // there and everything after it never runs.
    const six = buildConnectivityScript({ tag: 't', supportsRest: false })
    expect(six).not.toMatch(/www-ssl/)
    expect(six).toMatch(/no REST service/)
  })

  it('opens the API, which every RouterOS has', () => {
    expect(buildConnectivityScript({ tag: 't', supportsRest: false }))
      .toMatch(/name="api"/)
  })

  it('opens REST only on firmware that has it', () => {
    expect(buildConnectivityScript({ tag: 't', supportsRest: true }))
      .toMatch(/www-ssl/)
  })

  it('adds nothing that is already there', () => {
    const s = buildConnectivityScript({ tag: 't', supportsRest: true })
    // The variable is named for what it holds rather than reused as `$a`. What
    // matters is that a length check guards each add.
    expect(s).toMatch(/:if \(\[:len \$ispflowApi\] = 0\) do=\{/)
    expect(s).toMatch(/\[\/ip service find name="api"\]/)
    // And there is no bare top-level add, which is what would duplicate a
    // service on a second run.
    expect(s).not.toMatch(/^\/ip service add/m)
  })

  it('disables nothing', () => {
    expect(buildConnectivityScript({ tag: 't', supportsRest: true }))
      .not.toMatch(/disabled=yes/)
  })
})

describe('the package profile stage', () => {
  const script = buildProfileScript({
    tag: 'ab12',
    pools: [{ name: 'ispflow-pool', ranges: '10.10.0.2-10.10.0.254' }],
    profiles: [
      {
        objectName: 'Home_5M', rateLimit: '5M/2M',
        localAddress: null, remoteAddress: null, needsPpp: false,
      },
      {
        objectName: 'Fiber_100', rateLimit: '100M/100M',
        localAddress: '10.10.0.2-10.10.0.254',
        remoteAddress: '10.10.1.2-10.10.1.254', needsPpp: true,
      },
    ],
  })

  it('writes the rate limit the database supplied', () => {
    expect(script).toMatch(/rate-limit="5M\/2M"/)
  })

  it('creates a PPP profile only for a package that needs one', () => {
    expect(script).toMatch(/\/ppp profile/)
    expect(script).toMatch(/local-address="10\.10\.0\.2-10\.10\.0\.254"/)
  })

  it('tags what it creates so a later run can recognise it', () => {
    expect(script).toMatch(new RegExp(`comment="${OWNER}:ab12"`))
  })

  it('checks before adding, so re-running repairs instead of duplicating', () => {
    // Counts real `/menu/add` commands. This previously counted `do={ add `,
    // which was counting the illegal standalone-block form rather than the
    // configuration it was meant to describe.
    const adds = script.match(/^\s+\/(?:[a-z-]+(?: [a-z-]+)*) add /gm) ?? []
    // One pool + two HotSpot profiles + one PPP profile.
    expect(adds.length).toBe(4)
    // Every add sits behind a length check on the object it creates.
    const guards = script.match(/:if \(\[:len \$[A-Za-z][\w-]*\] = 0\) do=\{/g) ?? []
    expect(guards.length).toBe(adds.length)
  })

  it('never removes anything', () => {
    // This router may be carrying paying customers. Provisioning has no business
    // deleting an object it did not create in this run.
    for (const verb of ['remove', 'set ', 'unset']) {
      expect(script).not.toMatch(new RegExp(`^\\s*${verb}`, 'm'))
    }
  })

  it('carries no price and no secret', () => {
    expect(script).not.toMatch(/price/i)
    expect(script).not.toMatch(/shared-secret|password|secret=/)
  })
})

describe('the heartbeat stage', () => {
  const script = buildHeartbeatScript({
    tag: 'ab12', url: 'https://demo.supabase.co/functions/v1/heartbeat',
    token: 't'.repeat(48), intervalSeconds: 600,
  })

  it('verifies TLS when it reports in', () => {
    // An unchecked certificate is a heartbeat anyone on the path can forge.
    expect(script).toMatch(/check-certificate=yes/)
  })

  it('respects the interval it was given', () => {
    expect(script).toMatch(/interval=600s/)
  })

  it('creates the script and the entry only when absent', () => {
    // One heartbeat scheduler per router, however many times this runs. Without
    // the guards a second provisioning run leaves two schedulers fighting over a
    // small device, and the panel sees two heartbeats per interval.
    const adds = script.match(/^\s+\/(?:[a-z-]+(?: [a-z-]+)*) add /gm) ?? []
    const guards = script.match(/:if \(\[:len/g) ?? []
    expect(adds.length).toBe(2)
    expect(guards.length).toBe(2)
  })

  it('runs once immediately rather than waiting a whole interval', () => {
    // On a slow rural link the panel should not look dead for 10 minutes.
    expect(script).toMatch(/\/system script run/)
  })
})

describe('the verification stage', () => {
  const script = buildVerifyScript({
    tag: 'ab12', expectHotspot: true, expectPppoe: true,
  })

  it('changes nothing at all', () => {
    // A verification script that can write is not a verification script.
    for (const verb of ['add ', 'set ', 'remove', 'enable', 'disable']) {
      expect(script).not.toMatch(new RegExp(`^\\s*${verb}`, 'm'))
    }
  })

  it('checks the backup the run depends on actually exists', () => {
    expect(script).toMatch(/file find where name~"ispflow-backup-ab12"/)
  })

  it('checks the services the ISP selected really exist', () => {
    expect(script).toMatch(/hotspot user profile find/)
    expect(script).toMatch(/ppp profile find/)
  })

  it('checks the heartbeat is installed', () => {
    expect(script).toMatch(/scheduler find/)
  })

  it('reports the answer as one machine-readable line', () => {
    expect(script).toMatch(/ISPFlow: VERIFIED ok/)
    expect(script).toMatch(/ISPFlow: VERIFIED failed/)
  })

  it('does not demand PPPoE on a HotSpot-only router', () => {
    // Failing a router for lacking PPPoE when PPPoE was never wanted would block
    // onboarding for a reason the operator cannot act on.
    const hs = buildVerifyScript({ tag: 't', expectHotspot: true, expectPppoe: false })
    expect(hs).toMatch(/hotspot user profile find/)
    expect(hs).not.toMatch(/ppp profile find/)
  })
})