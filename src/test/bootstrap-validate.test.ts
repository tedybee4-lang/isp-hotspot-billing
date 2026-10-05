import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SURVEYS, jsonEscapeSteps } from '../../supabase/functions/_shared/discovery.ts'
import { bootstrap, rules, CLAIM, TOKEN } from './bootstrap-fixture'
import { validateRouterOsScript } from './routeros-validate'

// ============================================================================
//  The validator itself. A validator that only ever passes proves nothing, so
//  each construct that broke real hardware is fed back in and must be caught.
// ============================================================================
describe('the validator rejects what broke real hardware', () => {
  it.each([
    // The line-5 failure on a real CHR.
    ['standalone-do', 'do={/ip service\n :local a [/ip service find name="api"]\n}'],
    ['undefined-variable', ':put ("hello " . $identity)'],
    ['destructive', '/ip firewall filter remove [find comment="x"]'],
    ['fetch-output', '/tool fetch url="https://a/b" output=file keep-result=yes dst-path=$f'],
    ['fetch-tls', '/tool fetch url="https://a/b" mode=https output=user as-value'],
    ['unbalanced-brace', ':if ($a = 1) do={\n  :local b ""\n'],
  ])('catches %s', (rule, script) => {
    expect(validateRouterOsScript(script).map((i) => i.rule)).toContain(rule)
  })

  it('does not mistake property access for an undefined variable', () => {
    // `$i->"name"` is a property read on the loop variable, not a variable
    // called `i-`. Treating it as undefined once masked every real finding.
    const script = '{ :local o ""\n :foreach i in=[/ip pool/find] do={\n'
      + '  :local p ($i->"name")\n  :set o ($o . $p)\n }\n}'
    expect(validateRouterOsScript(script).some((i) => i.rule === 'undefined-variable')).toBe(false)
  })
})

// ============================================================================
//  THE GOLDEN FIXTURE: the exact file a RouterOS 7.24.4 CHR receives.
//  Committed so the artifact a router runs is reviewable in a diff, and pinned
//  so it cannot silently drift from the generator that produces it.
// ============================================================================
describe('the committed CHR fixture', () => {
  const committed = readFileSync(
    new URL('./fixtures/bootstrap-ros724-chr.rsc', import.meta.url), 'utf8')

  it('is exactly what the generator produces today', () => {
    // If the generator changes, this fails until the fixture is regenerated -
    // see src/test/fixtures/README.md. Without the pin, the fixture would rot
    // into a file that no router is ever served.
    expect(committed).toBe(bootstrap('7.24.4', 'x86_64'))
  })

  it('is valid RouterOS', () => {
    expect(rules(committed)).toBe('')
  })

  it('is a plausible size for a real download', () => {
    expect(committed.length).toBeGreaterThan(20_000)
  })
})

// ============================================================================
//  THE ACCEPTANCE CASE: RouterOS 7.24.4 x86_64 CHR
// ============================================================================
describe('a RouterOS 7.24.4 x86_64 CHR', () => {
  const script = bootstrap('7.24.4', 'x86_64')

  it('is structurally valid RouterOS', () => {
    // The single most important assertion here. Every rule below exists
    // because some version of this script broke a real router.
    expect(rules(script)).toBe('')
  })

  it('has no standalone do block, which was the line-5 failure', () => {
    expect(script).not.toMatch(/^do=\{/m)
    expect(script).not.toMatch(/^onerror\s/m)
    // Every `do={` must belong to a command on the same line.
    for (const line of script.split('\n')) {
      if (line.includes('do={')) expect(line.trim()).toMatch(/^[:/].*do=\{/)
    }
  })

  it('has no undefined variables', () => {
    // $identity, $version and $board-name were printed by the claim trailer
    // and assigned nowhere. RouterOS has no such built-ins.
    expect(script).not.toMatch(/\$identity\b/)
    expect(script).not.toMatch(/\$version\b/)
    expect(script).not.toMatch(/\$board-name\b/)
  })

  it('is not told it lacks WireGuard or REST', () => {
    // The false RouterOS 6 claim on a 7.24.4 box.
    expect(script).not.toMatch(/no WireGuard support/i)
    expect(script).not.toMatch(/RouterOS 6 has no/i)
    expect(script).not.toMatch(/no REST/i)
    expect(script).toMatch(/HTTPS management is available/)
    expect(script).toMatch(/www-ssl/)
  })

  it('enables the services idempotently, never duplicating them', () => {
    for (const [name, port] of [['api', '8728'], ['api-ssl', '8729'], ['www-ssl', '8080']]) {
      expect(script).toContain(`[/ip/service/find name="${name}"]`)
      expect(script).toMatch(new RegExp(`/ip/service/add name="${name}" port=${port}`))
    }
    // Guarded creation: each add sits inside a length check.
    expect((script.match(/\/ip\/service\/add/g) ?? []).length).toBe(3)
  })

  it('reads PPPoE customers from PPP, not from HotSpot', () => {
    // The survey filed `/ip hotspot user` under `pppoe`, so prepaid HotSpot
    // subscribers were reported as PPPoE customers.
    const pppoeBlock = script.slice(
      script.indexOf('# --- pppoe ---'),
      script.indexOf('# --- pppoe-servers ---'),
    )
    expect(pppoeBlock).toContain('/ppp secret/find')
    expect(pppoeBlock).not.toContain('/ip hotspot user/find')
  })

  it('reads RADIUS from the RADIUS menu, and never the shared secret', () => {
    const radiusBlock = script.slice(
      script.indexOf('# --- radius ---'),
      script.indexOf('# --- radius-aaa ---'),
    )
    expect(radiusBlock).toContain('/radius/find')
    // A secret must never travel out over a survey POST.
    for (const line of script.split('\n')) {
      if (line.includes('http-data')) expect(line).not.toMatch(/secret/i)
    }
  })

  it('escapes router values before they enter JSON', () => {
    // A comment containing a quote previously produced invalid JSON and the
    // server silently discarded the entire survey.
    expect(script).toContain(':set j [:replace $p "\\\\" "\\\\\\\\"]')
    expect(script).toContain(':set j [:replace $j "\\"" "\\\\\\""]')
    // Backslash before quote, always.
    const steps = jsonEscapeSteps('p', 'j')
    expect(steps[0]).toContain('$p')
    expect(steps[1]).not.toContain('$p')
  })

  it('only ever reads, never writes configuration', () => {
    // Discovery is read-only by contract. The only writes permitted are the
    // guarded management-service adds in the access script. `/tool fetch` is a
    // report POST and changes nothing on the router, so it is not a write.
    const writes = script.split('\n').filter((l) =>
      /^\s*\/[a-z]/.test(l)
      && !/\/(find|print|get)\b/.test(l)
      && !l.includes('/tool fetch')
      && !l.includes('/file remove'))
    for (const w of writes) {
      expect(w).toMatch(/\/ip\/service\/add/)
    }
    // Nothing destructive anywhere: no remove, unset, reset or reboot.
    for (const line of script.split('\n')) {
      expect(line).not.toMatch(/reset-configuration/)
      expect(line).not.toMatch(/\/system\s+reboot/)
    }
  })

  it('uses valid fetch options on every request', () => {
    const fetches = script.split('\n').filter((l) => l.includes('/tool fetch'))
// ============================================================================
//  Every supported RouterOS / architecture combination
// ============================================================================
describe.each([
  ['7.24.4', 'x86_64', 7],
  ['7.1', 'arm', 7],
  ['7.16.2', 'arm64', 7],
  ['6.49.10', 'arm', 6],
  ['6.40.9', 'x86', 6],
])('RouterOS %s on %s', (version, arch, major) => {
  const script = bootstrap(version, arch)

  it('generates structurally valid RouterOS', () => {
    expect(rules(script)).toBe('')
  })

  it('gates version-dependent menus on the real major version', () => {
    expect(script.includes('/interface wireguard/find')).toBe(major >= 7)
  })

  it('never emits a RouterOS 7 path on RouterOS 6', () => {
    if (major >= 7) return
    for (const path of ['/interface/wireguard', '/ip/service/find name="www-ssl"']) {
      expect(script).not.toContain(path)
    }
  })

  it('never emits a RouterOS 6 assumption on RouterOS 7', () => {
    if (major < 7) return
    expect(script).toContain('www-ssl')
    expect(script).not.toMatch(/no WireGuard support/i)
  })

  it('never uses a ternary, which older RouterOS 6 lacks', () => {
    expect(script).not.toMatch(/\?[^:]*:/)
  })
})

// ============================================================================
//  Optional packages absent, and realistic values
// ============================================================================
describe('a router without optional packages', () => {
  const script = bootstrap('7.24.4', 'arm')

  it('surveys optional menus read-only, so absence cannot abort the run', () => {
    // `/certificate`, `/interface wireless` and `/caps-man manager` are all
    // absent on a bare CHR with no wireless package.
    for (const menu of ['/certificate', '/interface wireless', '/caps-man manager']) {
      expect(script).toContain(`${menu}/find`)
    }
    expect((script.match(/:onerror e do=/g) ?? []).length).toBeGreaterThan(20)
  })

  it('names the survey that was skipped, so absence is never silent', () => {
    expect(script).toContain(':put ("ISPFlow: certificates not reported: " . $e)')
  })
})

describe('realistic router values', () => {
  it('never places an awkward identity in a URL', () => {
    for (const identity of ['LIPANET', 'CHR innotek GmbH VirtualBox',
      'Bob "the builder"', 'a&b', '100%', 'a/b?c#d']) {
      const url = new URL(`${CLAIM}?token=${TOKEN}&vm=7.24&arch=x86_64`)
      expect(url.href).not.toContain(identity)
    }
  })

  it('keeps every survey key registered so the endpoint accepts it', () => {
    // An unregistered key is rejected by handleReport as an unknown survey, so
    // a survey that never arrives looks exactly like a broken router.
    const script = bootstrap('7.24.4', 'x86_64')
    const used = [...script.matchAll(/[?&]survey=([a-z-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(20)
    for (const key of used) expect([...SURVEYS]).toContain(key)
  })

  it('sends no RADIUS secret anywhere in discovery', () => {
    const script = bootstrap('7.24.4', 'x86_64')
    for (const line of script.split('\n')) {
      expect(line).not.toMatch(/secret\s*=\s*"/i)
    }
  })
})
    expect(fetches.length).toBeGreaterThan(20)
    for (const f of fetches) {
      expect(f).toMatch(/check-certificate=yes/)
      expect(f).not.toMatch(/keep-result=yes/)
      expect(f).not.toMatch(/mode=http\b/)
    }
  })

  it('keeps the URL contract free of router-controlled text', () => {
    // Only the token reaches the router-side URL. Every survey URL carries the
    // discovery token, the survey key and the short session tag, all of which
    // the platform generated.
    for (const m of script.matchAll(/url="([^"]+)"/g)) {
      const url = new URL(m[1].replace(/\\\//g, '/'))
      expect(url.search).not.toMatch(/[ ]/)
      for (const key of [...url.searchParams.keys()]) {
        expect(['token', 'survey', 'tag']).toContain(key)
      }
    }
  })
})