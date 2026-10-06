/**
 * Router self-discovery: the properties the generated script must hold.
 *
 * This is a script that runs, as root, on a router that may be carrying paying
 * customers. A syntax error does not merely fail onboarding - it stops partway
 * through, on live hardware. So these assert the shape of the generated
 * RouterOS, not just that a function returns a string.
 *
 * Nothing here talks to a router. What was verified against real hardware, and
 * what was not, is recorded in the commit message.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDiscoveryScript, ros, SURVEYS,
  type DiscoveryOptions,
} from './discovery.ts'

const OPTS: DiscoveryOptions = {
  reportUrl: 'https://demo.supabase.co/functions/v1/router-provision/report',
  token: 'a'.repeat(48),
  major: 7,
  tag: 'ab12cd34',
}

describe('the discovery script is RouterOS a router can actually run', () => {
  const script = buildDiscoveryScript(OPTS)

  it('changes nothing: it is a read-only survey', () => {
    // Every configuration verb that would mutate the router. None may appear.
    for (const verb of [
      ' add ', ' remove ', ' set ', ' unset ', '/system/reboot',
      '/system/reset-configuration', 'factory-reset',
    ]) {
      expect(script, `discovery must never ${verb.trim()}`).not.toContain(verb)
    }
  })

  it('verifies TLS on every fetch', () => {
    // RouterOS does NOT check certificates by default. Without this the survey
    // and its token travel over a link any proxy can rewrite.
    const fetches = script.split('/tool fetch').length - 1
    expect(fetches).toBeGreaterThan(5)
    const verified = script.split('check-certificate=yes').length - 1
    expect(verified, 'every fetch must set check-certificate=yes').toBe(fetches)
  })

  it('never sends a credential', () => {
    // The discovery token is the only secret in play, and it travels in the URL
    // where the router already has it. No password, key or secret VALUE.
    //
    // `/ppp secret` is a MENU, not a credential: PPP accounts live there and
    // must be read so provisioning can see them. Only a secret-bearing
    // PROPERTY would be a leak, and none is requested from it.
    const lower = script.toLowerCase()
    for (const forbidden of ['password', 'private-key', 'shared-key',
      'secret=', 'secret =', '"secret"', 'shared-secret']) {
      expect(lower).not.toContain(forbidden)
    }
    // The PPP secret menu is read for names and profiles only.
    const pppSecretBlock = script.slice(
      script.indexOf('/ppp secret/find'),
      script.indexOf('/ppp secret/find') + 2000,
    )
    expect(pppSecretBlock).not.toMatch(/password/)
  })

  it('balances every block it opens', () => {
    // An unbalanced brace means the import aborts mid-file on a live router.
    const opens = (script.match(/\{/g) ?? []).length
    const closes = (script.match(/\}/g) ?? []).length
    expect(opens, 'every { must be closed').toBe(closes)
  })

  it('wraps each survey so one failure cannot stop the rest', () => {
    // The canonical guard is `:do { ... } on-error={ ... }` - not `:onerror`.
    const blocks = script.split('on-error={').length - 1
    expect(blocks, 'every survey needs its own error trap').toBeGreaterThan(15)
  })

  it('groups the POST body as one argument', () => {
    // The canonical fetch takes the payload as ONE variable, declared right
    // above it as one parenthesised expression. An unparenthesised
    // `http-data="{" . $o . "}"` parses as a body of literally `{` followed by
    // a dangling concatenation: the quotes close the string immediately and the
    // survey posts `{"name":""}`, silently discarding everything the router had
    // read. No unit test on a return value would ever have caught this - only
    // looking at the generated RouterOS did.
    const posts = script.split('\n').filter((l) => l.includes('http-data='))
    expect(posts.length).toBeGreaterThan(5)
    for (const p of posts) expect(p).toMatch(/http-data=\$jsonPayload;$/)
    expect(script).toContain(':local jsonPayload ("[" . $rows . "]")')
    expect(script).not.toMatch(/http-data="\{"/)
  })

  it('never uses a ternary, which is absent on older RouterOS 6 builds', () => {
    // A 32 MB RB951 has to be able to run this. The separator is built with an
    // explicit :if for exactly that reason.
    expect(script).not.toMatch(/\)\s*\?/)
  })
})

describe('discovery covers what decides whether provisioning is safe', () => {
  const script = buildDiscoveryScript(OPTS)

  it('reads every subsystem the panel needs to judge an existing router', () => {
    // The question is not "what is this box" but "what is ALREADY on it", so
    // the production subsystems are the ones that must not be missing.
    for (const menu of [
      '/interface/find', '/interface bridge/find', '/interface vlan/find',
      '/ip address/find', '/ip dhcp-server/find', '/ip pool/find',
      '/ip hotspot/find', '/ip hotspot user/find', '/ppp profile/find',
      '/ip firewall filter/find', '/ip firewall nat/find', '/ip route/find',
      '/ip dns/find', '/ip service/find', '/certificate/find',
      '/system scheduler/find', '/system script/find', '/system package/find',
    ]) {
      expect(script, `${menu} must be surveyed`).toContain(menu)
    }
  })

  it('reports identity, hardware and resources', () => {
    expect(script).toContain('/system identity/get name')
    expect(script).toContain('/system resource/get version')
    expect(script).toContain('/system resource/get board-name')
    expect(script).toContain('/system resource/get architecture-name')
    expect(script).toContain('/system resource/get total-memory')
  })

  it('keeps the operator\'s own port comments, the best label there is', () => {
    // "UPLINK" written by the incumbent operator is worth more than any guess
    // this platform could make about ether1.
    expect(script).toContain('($i->"comment")')
  })
})

describe('version gating is decided by the router, not assumed', () => {
  it('asks RouterOS 7 boxes about WireGuard', () => {
    expect(buildDiscoveryScript(OPTS)).toContain('/interface wireguard/find')
  })

  it('does not send a RouterOS 7 path to a RouterOS 6 box', () => {
    const six = buildDiscoveryScript({ ...OPTS, major: 6 })
    expect(six).not.toContain('/interface wireguard/find')
    // And says so, rather than letting the panel infer "unsupported".
    expect(six).toContain('skipped')
    expect(six).toContain('RouterOS 6 has no WireGuard support')
  })

  it('surveys both majors identically apart from the gated menus', () => {
    const seven = buildDiscoveryScript(OPTS)
    const six = buildDiscoveryScript({ ...OPTS, major: 6 })
    // The expensive firewall walk happens on both: an ISP needs to see it
    // whichever firmware they are on.
    expect(seven).toContain('/ip firewall filter/find')
    expect(six).toContain('/ip firewall filter/find')
  })
})

describe('the script is sized for the routers it must run on', () => {
  it('stays modest: a router downloads it to a file and imports it', () => {
    // The 63 KiB figure in the manual is the cap on `output=user`, i.e. the
    // RESPONSE body of one fetch - not on a script file the router streams to
    // disk and imports. That is why this bound is on the whole script rather
    // than per survey.
    // Raised from 48 KB when PPPoE and RADIUS were split into the menus RouterOS
  // actually uses (`/ppp secret`, `/interface/pppoe-server/server`,
  // `/ppp profile`, `/radius`, `/ppp aaa`) and every value began passing through
  // a JSON escaper. Both changes are correctness fixes: the old script filed
  // HotSpot users under pppoe and produced invalid JSON for any value
  // containing a quote.
  //
  // The 63 KiB manual figure is the cap on `output=user`, i.e. the RESPONSE body
  // of one fetch - not on a script file the router streams to disk and imports.
  // This bound is on the whole script, and it stays comfortably under 63 KiB so
  // the script itself is never the thing that fails on a small device.
  expect(buildDiscoveryScript(OPTS).length).toBeLessThan(63_000)
  })

  it('never assembles one document that a single fetch would have to carry', () => {
    // This is the constraint that actually matters: a batched body would be
    // silently truncated on a router with many interfaces, and one missing menu
    // would lose every other answer.
    const script = buildDiscoveryScript(OPTS)
    for (const survey of ['interfaces', 'ip_pools', 'hotspot', 'firewall']) {
      expect(script).toContain(`survey=${survey}`)
    }
    // 25 separate posts, not one.
    expect(script.split('/tool fetch').length - 1).toBeGreaterThan(20)
  })
})

describe('untrusted values cannot break out of the generated script', () => {
  it('escapes quotes and backslashes in interpolated values', () => {
    expect(ros('a"b')).toBe('a\\"b')
    expect(ros('a\\b')).toBe('a\\\\b')
  })

  it('escapes a hostile report URL instead of executing it', () => {
    const evil = buildDiscoveryScript({
      ...OPTS,
      reportUrl: 'https://x/"; /system/reboot; #',
    })
    // The payload text is present, but it can only ever be DATA: the quote that
    // would end the string literal is escaped, so the reboot stays inside the
    // quoted URL instead of becoming a second command. The URL is declared
    // once as `$baseUrl` and referenced from the fetch lines, so that
    // declaration is the line to assert on. The exact delimiter count is not
    // the property under test - other arguments are legitimately quoted too -
    // so assert the escape itself.
    const line = evil.split('\n').find((l) => l.includes(':local baseUrl'))!
    expect(line).toContain('\\"; /system/reboot; #')
    // A bare, unescaped `";` would close the literal and start a new command.
    expect(line).not.toMatch(/(?<!\\)"; /)
  })
})

describe('the survey list is closed', () => {
  it('names every subsystem the report endpoint will accept', () => {
    // The endpoint rejects anything outside this list, so a stale router script
    // cannot grow the table without bound.
    expect(SURVEYS).toContain('interfaces')
    expect(SURVEYS).toContain('ispflow')
    expect(new Set(SURVEYS).size).toBe(SURVEYS.length)
  })
})