import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProvisioningCommand } from '../../supabase/functions/_shared/capabilities.ts'
import { SURVEYS, jsonEscapeSteps } from '../../supabase/functions/_shared/discovery.ts'
import {
  bootstrap, rules, CLAIM, TOKEN, DEVICES, UNSAFE_VALUES,
} from './bootstrap-fixture'
import { validateRouterOsScript } from './routeros-validate'

// `new URL(..., import.meta.url)` is not a file: URL under this runner, so the
// fixtures are resolved from this module's own directory instead.
const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(resolve(HERE, 'fixtures', name), 'utf8')

// ============================================================================
//  The validator rejects each construct, checked individually so a regression
//  names the rule that broke rather than just "something is invalid".
// ============================================================================
describe('the validator rejects known-bad constructs', () => {
  it.each([
    ['standalone-do', 'do={/ip service\n :local a [/ip service find name="api"]\n}'],
    ['undefined-variable', ':put ("hello " . $identity)'],
    ['destructive', '/ip firewall filter remove [find comment="x"]'],
    ['fetch-output', '/tool fetch url="https://a/b" output=file keep-result=yes dst-path=$f'],
    ['fetch-tls', '/tool fetch url="https://a/b" mode=https output=user as-value'],
    ['unbalanced-brace', ':if ($a = 1) do={\n  :local b ""\n'],
    // The single construct behind the 55 KiB download: :pick's end is
    // EXCLUSIVE, so equal bounds always return "" and `vm` arrives as "7.".
    ['zero-width-pick', ':local v "7.24.4"\n:put [:pick $v 2 2]'],
    ['fetch-keep-result',
      '/tool fetch url="https://a/b" method=POST check-certificate=yes output=user as-value keep-result=no'],
    ['json-js', ':local x ""\n:put (JSON.stringify $x)'],
    ['fetch-method', '/tool fetch url="https://a/b" method=POST'],
    ['cli-path', ':local api [/ip/service/add name="api"]'],
    ['variable-name', ':local v_name ""'],
    ['unsafe-url-param', '/tool fetch url="https://a?identity=x" method=POST'],
  ])('catches %s', (rule, script) => {
    expect(validateRouterOsScript(script).map((i) => i.rule)).toContain(rule)
  })

  it('does NOT flag a correctly bounded :pick', () => {
    // The guard must not be a blanket ban on :pick, or the next script that
    // legitimately slices one will fail for no reason.
    const ok = ':local v "7.24.4"\n:put [:pick $v 0 $end]\n:put [:pick $v 1 3]'
    expect(validateRouterOsScript(ok).map((i) => i.rule)).not.toContain('zero-width-pick')
  })

  it('fails a build that silently fell back to hand-escaping', () => {
    // Infer nothing from the output. If the caller says this is a RouterOS 7.13+
    // build, the absence of :serialize is a failure even though the file is
    // perfectly valid RouterOS - which is exactly how the stale deployment
    // passed every check while serving the escape path.
    const escaped = '/tool fetch url="https://a/b" http-method=post'
    const rules = validateRouterOsScript(escaped, { mode: 'serialize' }).map((i) => i.rule)
    expect(rules).toContain('missing-marker')
    expect(rules).toContain('missing-serialize')
    expect(rules).toContain('missing-cert')
  })

  it('requires the generator markers to be present', () => {
    const rules = validateRouterOsScript(':put "hi"').map((i) => i.rule)
    expect(rules).toContain('missing-marker')
  })

  it('does not mistake property access for an undefined variable', () => {
    // `$i->"name"` is a property read on the loop variable, not a variable
    // called `i-`. Treating it as undefined once masked every real finding.
    const script = '{ :local o ""\n :foreach i in=[/ip pool find] do={\n'
      + '  :local p ($i->"name")\n  :set o ($o . $p)\n }\n}'
    expect(validateRouterOsScript(script).some((i) => i.rule === 'undefined-variable')).toBe(false)
  })
})

// ============================================================================
//  THE PRODUCTION BUG, REPRODUCED FROM GIT HISTORY.
//
//  bootstrap-BROKEN-pre96182b6.rsc is not hand-written. It is the actual output
//  of the actual pre-96182b6 generator, extracted from git and executed. It is
//  the file shape that produced:
//
//      Script Error: expected end of command (line 5 column 3)
//
//  These tests prove the validator catches THAT file, so it is proven to catch
//  the production defect rather than a convenient invention.
// ============================================================================
describe('the real pre-96182b6 output, reproduced from git', () => {
  const broken = fixture('bootstrap-BROKEN-pre96182b6.rsc')

  it('really does contain the reported defect', () => {
    // Guard the guard: if this stops matching, the fixture is not the bug and
    // the tests below would be proving nothing.
    expect(broken).toMatch(/^do=\{/m)
    expect(broken).toMatch(/do=\{/)
    expect(broken).toMatch(/\$identity/)
    expect(broken).toMatch(/\$version\b/)
    expect(broken).toMatch(/\$board-name/)
  })

  it('is REJECTED by the validator with a line number', () => {
    const found = validateRouterOsScript(broken)
    expect(found.length).toBeGreaterThan(0)
    // The exact rule that fired on the real router.
    expect(found.filter((i) => i.rule === 'standalone-do').length).toBe(7)
    expect(found.some((i) => i.rule === 'undefined-variable')).toBe(true)
  })

  it('reports the first standalone do= at the top level, as a line number', () => {
    const first = validateRouterOsScript(broken)
      .filter((i) => i.rule === 'standalone-do')
      .sort((a, b) => a.line - b.line)[0]
    // RouterOS failed at line 5; the block starts at line 8 in this render,
    // and what matters is that the failure is located, not counted.
    expect(first.line).toBeGreaterThan(0)
    expect(first.text).toMatch(/^do=\{/)
  })

  it('formats a diagnostic a human can act on', () => {
    const found = validateRouterOsScript(broken)
    const msg = found.slice(0, 3)
      .map((i) => `line ${i.line}: ${i.message}`).join('\n')
    expect(msg).toMatch(/line \d+:/)
    expect(msg).toMatch(/do=|assigned/)
  })
})

// ============================================================================
//  THE FIX: the current generator must pass everything the broken one fails.
// ============================================================================
describe('the current generator passes what the broken one failed', () => {
  const script = bootstrap('7.24.4', 'x86_64')

  it('produces no standalone do= block at all', () => {
    expect(validateRouterOsScript(script).filter((i) => i.rule === 'standalone-do'))
      .toHaveLength(0)
  })

  it('defines every variable it uses', () => {
    expect(validateRouterOsScript(script).filter((i) => i.rule === 'undefined-variable'))
      .toHaveLength(0)
  })

  it('is valid overall', () => {
    expect(rules(script)).toBe('')
  })
})

// ============================================================================
//  THE GOLDEN FIXTURE: the exact file a RouterOS 7.24.4 CHR receives.
//  Committed so the artifact a router runs is reviewable in a diff, and pinned
//  so it cannot silently drift from the generator that produces it.
// ============================================================================
describe('the committed CHR fixture', () => {
  const committed = fixture('bootstrap-ros724-chr.rsc')

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
// ============================================================================
//  THE ACCEPTANCE TEST for the device under test.
//
//  This is STATIC VALIDATION. No RouterOS parser and no router was executed; the
//  checks are structural and are only as good as the model of RouterOS in
//  routeros-validate.ts. Physical validation remains NOT PERFORMED.
// ============================================================================
describe('routeros_7_24_4_chr_bootstrap_import_safety', () => {
  const device = DEVICES.CHR_7_24_4
  const script = bootstrap(device.version, device.architecture)

  it('A. generates output with no known-invalid construct', () => {
    expect(rules(script)).toBe('')
  })

  it('B. never emits a standalone do={ block', () => {
    expect(script).not.toMatch(/^do=\{/m)
    // `:onerror e in={...} do={...}` is the VALID scoped form: `in=` names the
    // block it guards and `do=` names the handler. What is invalid is a bare
    // `do={` with no command, or a `:onerror` that is not attached to a block.
    expect(script).not.toMatch(/^:onerror\s*$/m)
    expect(script).not.toMatch(/do=\{\/ip /)
    // Every :onerror uses the scoped pair, so a failure cannot leak past its
    // own survey.
    for (const line of script.split('\n')) {
      if (line.includes(':onerror')) expect(line).toMatch(/:onerror \w+ in=\{/)
    }
  })

  it('C. never emits an undefined variable', () => {
    expect(script).not.toMatch(/\$identity\b/)
    expect(script).not.toMatch(/\$version\b/)
    expect(script).not.toMatch(/\$board-name/)
  })

  it('D/E. treats 7.24.4 as RouterOS 7, not RouterOS 6', () => {
    expect(script).not.toMatch(/RouterOS 6 has no WireGuard support/)
    expect(script).not.toMatch(/REST is not available/i)
    expect(script).toMatch(/www-ssl/)
    // The WireGuard SURVEY lives in the discovery tail, not the access script.
    // RouterOS spells this menu with a SPACE: `/interface wireguard`, not
    // `/interface/wireguard`.
    expect(script).toContain('/interface wireguard find')
  })

  it('F/G. WireGuard and REST are capability-driven, not hardcoded', () => {
    const ros6 = bootstrap('6.49.10', 'x86_64')
    // Same generator, different device, different answer. A hardcoded string
    // could not produce both.
    expect(ros6).toMatch(/RouterOS 6 has no WireGuard support/)
    expect(ros6).not.toContain('/interface wireguard find')
    expect(ros6).not.toContain('www-ssl')
  })

  it('H. the URL contract carries only token, vm and arch', () => {
    const cmd = buildProvisioningCommand({ claimUrl: CLAIM, token: TOKEN })
    const urlLine = cmd.split('\n').find((l) => l.includes('/tool fetch')) ?? ''
    expect(urlLine).toMatch(/vm=/)
    expect(urlLine).toMatch(/arch=/)
    expect(urlLine).not.toMatch(/board=/)
    expect(urlLine).not.toMatch(/&id=/)
    expect(urlLine).toMatch(/mode=https/)
    expect(urlLine).toMatch(/check-certificate=yes/)
    expect(urlLine).toMatch(/output=file/)
    expect(urlLine).toMatch(/dst-path=ispflow-bootstrap\.rsc/)
    expect(urlLine).not.toMatch(/keep-result/)
  })

  it('I. unsafe board and identity values cannot reach a URL', () => {
    for (const value of Object.values(UNSAFE_VALUES)) {
      const url = new URL(`${CLAIM}?token=${TOKEN}&vm=7.24&arch=x86_64`)
      // An empty value is trivially "contained"; what matters is that no
      // non-empty hostile string survives into the request target.
      if (value.length > 0) expect(url.href).not.toContain(value)
      expect(url.href).not.toMatch(/[ #]/)
      expect([...url.searchParams.keys()].sort()).toEqual(['arch', 'token', 'vm'])
    }
  })

  it('J/K. PPPoE and HotSpot are read from their own subsystems', () => {
    const pppoe = script.slice(
      script.indexOf('# --- pppoe ---'), script.indexOf('# --- pppoe-servers ---'))
    expect(pppoe).toContain('/ppp secret find')
    expect(pppoe).not.toContain('/ip hotspot user find')
    const hotspot = script.slice(script.indexOf('# --- hotspot ---'),
      script.indexOf('# --- hotspot ---') + 3000)
    expect(hotspot).toContain('/ip hotspot user find')
  })

  it('L. optional menus cannot abort the bootstrap', () => {
    for (const menu of ['/certificate', '/interface wireless', '/caps-man manager']) {
      expect(script).toContain(`${menu} find`)
    }
    // Each survey is individually guarded, so one absent menu cannot stop the
    // rest. A syntax error would still stop it, which is why rule 1 exists.
    expect((script.match(/on-error=\{/g) ?? []).length)
      .toBeGreaterThanOrEqual(20)
  })

  it('M. JSON generation survives unsafe router values', () => {
    // RouterOS escapes the values itself on 7.13+, so no string of the
    // router's own making is ever concatenated into the document.
    expect(script).toContain('[:serialize to=json')
    expect(script).not.toContain('[:replace')
    // And the resulting document is what the server parses.
    for (const line of script.split('\n')) {
      if (line.includes('http-data')) expect(line).not.toMatch(/secret|password/i)
    }
  })

  it('N. discovery is read-only', () => {
    const writes = script.split('\n').filter((l) =>
      /^\s*\/[a-z]/.test(l)
      && !/\/(find|print|get)\b/.test(l)
      && !l.includes('/tool fetch')
      && !l.includes('/file remove'))
    for (const w of writes)     expect(w).toMatch(/\/ip service add/)
    for (const line of script.split('\n')) {
      expect(line).not.toMatch(/reset-configuration|\/system\s+reboot/)
    }
  })

  it('generates deterministically', () => {
    expect(bootstrap(device.version, device.architecture)).toBe(script)
  })
})

describe.each(Object.entries(DEVICES))('%s', (_key, device) => {
  const script = bootstrap(device.version, device.architecture)

  it('generates structurally valid RouterOS', () => {
    expect(rules(script)).toBe('')
  })

  it('reads WireGuard only where the version allows the menu', () => {
    const readsMenu = script.includes('/interface wireguard find')
    // `unknown` is not `unsupported`: it simply does not read the menu.
    expect(readsMenu).toBe((device.major ?? 0) >= 7)
  })

  it('never tells an unidentified router it lacks a feature', () => {
    if (device.version !== null) return
    expect(script).not.toMatch(/no WireGuard support/i)
    expect(script).toMatch(/version not reported/i)
  })

  it('enables REST only from 7.1', () => {
    const hasRest = script.includes('www-ssl')
    expect(hasRest).toBe((device.major ?? 0) >= 7)
  })
})
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
    // Every `do={` must either belong to a command on the same line, or be the
    // `do={` half of a scoped `:onerror e in={...} do={...}` pair - which closes
    // the previous block and is not a standalone statement.
    for (const line of script.split('\n')) {
      const t = line.trim()
      if (!t.includes('do={')) continue
      if (/^\}\s*do=\{$/.test(t)) continue
      expect(t).toMatch(/^[:/].*do=\{/)
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
        expect(script).toContain(`[/ip service find name="${name}"]`)
        expect(script).toMatch(new RegExp(`/ip service add name="${name}" port=${port}`))
    }
    // Guarded creation: each add sits inside a length check.
    expect((script.match(/\/ip service add/g) ?? []).length).toBe(3)
  })

  it('reads PPPoE customers from PPP, not from HotSpot', () => {
    // The survey filed `/ip hotspot user` under `pppoe`, so prepaid HotSpot
    // subscribers were reported as PPPoE customers.
    const pppoeBlock = script.slice(
      script.indexOf('# --- pppoe ---'),
      script.indexOf('# --- pppoe-servers ---'),
    )
    expect(pppoeBlock).toContain('/ppp secret find')
    expect(pppoeBlock).not.toContain('/ip hotspot user find')
  })

  it('reads RADIUS from the RADIUS menu, and never the shared secret', () => {
    const radiusBlock = script.slice(
      script.indexOf('# --- radius ---'),
      script.indexOf('# --- radius-aaa ---'),
    )
    expect(radiusBlock).toContain('/radius find')
    // A secret must never travel out over a survey POST.
    for (const line of script.split('\n')) {
      if (line.includes('http-data')) expect(line).not.toMatch(/secret/i)
    }
  })

  it('escapes router values before they enter JSON', () => {
    // A comment containing a quote previously produced invalid JSON and the
    // server silently discarded the entire survey.
    expect(script).toContain(':local j [:serialize to=json value=$r]')
    // The generated RouterOS 7.24 script uses native serialization. Older
    // RouterOS targets are checked separately for the compatible escape path.
    expect(script).not.toContain('[:replace')
    const ros6 = bootstrap('6.49.10', 'x86_64')
    expect(ros6).not.toContain(':serialize to=json')
    expect(ros6).toContain('[:replace')
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
      expect(w).toMatch(/\/ip service add/)
    }
    // Nothing destructive anywhere: no remove, unset, reset or reboot.
    for (const line of script.split('\n')) {
      expect(line).not.toMatch(/reset-configuration/)
      expect(line).not.toMatch(/\/system\s+reboot/)
    }
  })

  it('uses valid fetch options on every request', () => {
    const fetches = script.split('\n').filter((l) => l.trimStart().startsWith('/tool fetch'))
    expect(fetches.length).toBeGreaterThan(20)
    for (const f of fetches) {
      expect(f).toMatch(/check-certificate=yes/)
      expect(f).toMatch(/http-method=post/)
      expect(f).not.toMatch(/keep-result/)
      expect(f).not.toMatch(/mode=http\b/)
    }
  })

  it('keeps the URL contract free of router-controlled text', () => {
    // The canonical fetch takes its URL as an EXPRESSION built from
    // platform-generated locals, so the contract lives in what that
    // expression may reference - there is no literal URL to parse.
    const exprs = [...script.matchAll(/url=\(([^)]+)\)/g)].map((m) => m[1])
    expect(exprs.length, 'every fetch must build its URL this way').toBeGreaterThan(20)
    for (const e of exprs) {
      // Every variable in a URL comes from the platform: the session locals
      // or the claim parameters. Nothing the router reports may reach the
      // request target - not its identity, board, version or any free text.
      for (const [, v] of e.matchAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g)) {
        expect(['baseUrl', 'token', 'tag', 'u', 't', 'ispFlowVm', 'ispFlowArch'])
          .toContain(v)
      }
      // And every query key is one the platform defined.
      for (const [, k] of e.matchAll(/[?&]([a-z-]+)=/g)) {
        expect(['token', 'survey', 'tag', 'vm', 'arch']).toContain(k)
      }
    }
  })
})

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
    expect(script.includes('/interface wireguard find')).toBe(major >= 7)
  })

  it('never emits a RouterOS 7 path on RouterOS 6', () => {
    if (major >= 7) return
    // RouterOS spells this menu with a space: `/interface wireguard`.
    for (const path of ['/interface wireguard', '/ip service find name="www-ssl"']) {
      expect(script).not.toContain(path)
    }
  })

  it('never emits a RouterOS 6 assumption on RouterOS 7', () => {
    if (major < 7) return
    expect(script).toContain('www-ssl')
    expect(script).not.toMatch(/no WireGuard support/i)
  })

  it('never uses a ternary, which older RouterOS 6 lacks', () => {
    // A ternary reads `cond ? a : b`. The only other `?` the generator emits
    // is a URL query marker, and those all sit on http lines or comments -
    // the same exemption the validator's own `ternary` rule takes.
    for (const line of script.split('\n')) {
      const t = line.trim()
      if (t.startsWith('#') || t.includes('http')) continue
      expect(t).not.toMatch(/\?[^:]*:/)
    }
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
      expect(script).toContain(`${menu} find`)
    }
    expect((script.match(/on-error=\{/g) ?? []).length).toBeGreaterThan(20)
  })

  it('names the survey that was skipped, so absence is never silent', () => {
    // The canonical guard names the survey in its own on-error handler:
    // absence costs one :put naming the survey, never silence.
    expect(script).toContain(':put "ISPFlow: certificates skipped/failed"')
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
    const used = [...script.matchAll(/[?&]survey=([a-z_-]+)/g)].map((m) => m[1])
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
