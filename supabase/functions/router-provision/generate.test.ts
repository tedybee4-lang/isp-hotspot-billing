/**
 * The canonical all-in-one provisioning script, asserted by its BYTES.
 *
 * generate.ts documents a non-negotiable format: one master `{ }` block,
 * `[:toarray \"\"]` maps, `:do { } on-error={ }` guards on every block, and one
 * exact `/tool fetch` shape carrying `http-data=$jsonPayload`. A regression
 * here runs on a customer's router as root, so every invariant of that
 * contract is checked against the generated RouterOS itself - including the
 * validator that has caught every production defect found so far.
 *
 * Nothing here talks to a router or a server.
 */
import { describe, expect, it } from 'vitest'
import { validateRouterOsScript } from '../../../src/test/routeros-validate'
import { SURVEYS } from '../_shared/discovery.ts'
import {
  GENERATE_MARKER, buildGenerateScript, ensure, pingUrl,
  type GenerateOptions,
} from './generate.ts'

const OPTS: GenerateOptions = {
  token: 'a'.repeat(48),
  tag: 'abcd1234',
  reportUrl: 'https://demo.supabase.co/functions/v1/router-provision/report',
  major: 7,
  minor: 24,
  architecture: 'x86_64',
}

const script = buildGenerateScript(OPTS)

/** Survey fetch statements - the lines that begin with the fetch command. */
const fetchLines = script
  .split('\n')
  .filter((l) => l.trimStart().startsWith('/tool fetch'))

describe('the all-in-one script is structurally valid RouterOS', () => {
  it('passes the validator with the serialize strategy pinned', () => {
    const found = validateRouterOsScript(script, { mode: 'serialize' })
    expect(found.map((i) => `${i.rule}@L${i.line}: ${i.message}`)).toEqual([])
  })

  it('is deterministic: the same session always yields the same bytes', () => {
    expect(buildGenerateScript(OPTS)).toBe(script)
  })

  it('carries every generator marker, so a stale deploy is visible in the bytes', () => {
    expect(script).toContain(GENERATE_MARKER)
    expect(script).toContain('# ISPFlow-BOOTSTRAP-GENERATOR-528C90')
    expect(script).toContain('# ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR')
  })

  it('is sized for a real download: whole bootstrap, under the response cap', () => {
    expect(script.length).toBeGreaterThan(20_000)
    expect(script.length).toBeLessThan(63_000)
  })
})

describe('one master block, exactly as the canonical template specifies', () => {
  it('is one `{ }` wrapping everything after the comment header', () => {
    const body = script
      .split('\n')
      .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    expect(body[0], 'first statement must open the master block').toBe('{')
    expect(body[body.length - 1], 'last statement must close it').toBe('}')
    expect(script.split('\n').filter((l) => l === '{')).toHaveLength(1)
    expect(script.split('\n').filter((l) => l === '}')).toHaveLength(1)
  })

  it('declares the session locals exactly once, ahead of everything else', () => {
    for (const name of ['token', 'tag', 'baseUrl']) {
      expect(
        script.split(`:local ${name} `).length - 1,
        `$${name} must be declared once, not repeated per survey`,
      ).toBe(1)
    }
  })

  it('builds the URL from a local and query params, not inline literals', () => {
    for (const line of fetchLines) {
      expect(line).toMatch(/url=\(/)
    }
  })

  it('names all three discovered services in the banner section', () => {
    const banner = script.split('# 1. ')[0]
    expect(banner).toContain('ISPFlow')
    expect(banner).toContain('canonical')
    expect(banner).toContain('discover')
  })
})

describe('the discovery section is present and sane', () => {
  it('starts with "1. Enable Required"', () => {
    expect(script.split('# 1. ')[1].startsWith('Enable')).toBe(true)
  })

  it('contains every required survey', () => {
    const discovery = script.split('# 2. ')[0]
    for (const survey of ['identity', 'interfaces', 'ip_pools', 'hotspot', 'firewall']) {
      expect(discovery).toContain(`survey=${survey}`)
    }
  })

  it('posts each survey to a separate fetch', () => {
    const discovery = script.split('# 2. ')[0]
    const fetches = discovery.split('/tool fetch').length - 1
    expect(fetches).toBeGreaterThan(10)
  })
})

describe('the canonical fetch statement', () => {
  it('carries the JSON payload in a variable, not a literal', () => {
    for (const line of fetchLines) {
      expect(line).toContain('http-data=$jsonPayload')
    }
  })

  it('uses the exact mode, method, and header field names', () => {
    for (const line of fetchLines) {
      expect(line).toContain('mode=https')
      expect(line).toContain('http-method=post')
      expect(line).toContain('check-certificate=yes')
      expect(line).toContain('http-header-field="Content-Type:application/json"')
      expect(line).toContain('output=none')
    }
  })

  it('uses the RouterOS http-method property and never keep-result', () => {
    for (const line of fetchLines) {
      expect(line).not.toContain('method=POST')
      expect(line).not.toContain('keep-result')
    }
  })

  it('uses one JSON strategy per RouterOS version', () => {
    for (const line of script.split('\n')) {
      if (line.includes(':serialize')) {
        expect(line).toContain('to=json')
      }
    }
    expect(script).toContain(':serialize to=json')
    expect(script).not.toContain('[:replace')
    const ros6 = buildGenerateScript({ ...OPTS, major: 6, minor: 49 })
    expect(ros6).not.toContain(':serialize to=json')
    expect(ros6).toContain('[:replace')
    expect(validateRouterOsScript(ros6, { mode: 'escape' })).toEqual([])
  })

  it('uses RouterOS CLI path syntax rather than API slash paths', () => {
    expect(script).not.toMatch(/\/(?:ip|interface|system|ppp|radius|user|file)\/(?:[^ \]\r\n]+\/)*(?:add|find|set|print|get|remove|save|run)\b/)
  })
})

describe('every stateful operation is guarded by an existence check', () => {
  it('wraps every object creation in an existence check', () => {
    const lines = script.split('\n')
    const adds = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => / add /.test(l) && !l.trimStart().startsWith('#') && !l.includes(':put'))
    expect(adds.length).toBeGreaterThanOrEqual(5)
    for (const { l, i } of adds) {
      const guarded = l.includes('= 0) do=')
        || (i > 0 && lines[i - 1].includes('= 0) do='))
      expect(guarded, `unguarded add would duplicate on re-run: ${l.trim()}`)
        .toBe(true)
    }
  })

  it('creates exactly the objects the platform owns, by name', () => {
    for (const name of [
      'ispflow-hotspot-pool', 'ispflow-pppoe-pool', 'ispflow-hs-profile',
      'ispflow-pppoe-profile', 'ispflow-heartbeat', 'ispflow-heartbeat-job',
    ]) {
      expect(script).toContain(name)
    }
    expect(script).toContain('interval=1m')
    expect(script).toContain('on-event="ispflow-heartbeat"')
  })

  it('ensure() emits the check-then-create form', () => {
    const lines = ensure('/ip pool', 'name="x"', '/ip pool add name="x";')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines[0]).toContain(':if')
    expect(lines[0]).toContain('[:len')
    expect(lines[0]).toContain('do={')
    expect(lines.some((l) => l.includes('/ip pool add name="x"'))).toBe(true)
    expect(lines.some((l) => l.trim() === '};')).toBe(true)
  })
})

describe('RADIUS is configured only when the panel supplies a server', () => {
  it('invents nothing: no server means no /radius add', () => {
    expect(script).not.toContain('/radius add')
    expect(script).toContain('no RADIUS server in this bootstrap')
  })

  it('a supplied server is guarded and its secret never reaches a fetch', () => {
    const withRadius = buildGenerateScript({
      ...OPTS,
      radius: { address: '10.0.0.1', secret: 's3cr3t-value' },
    })
    expect(withRadius).toContain(':if ([:len [/radius find address="10.0.0.1"]] = 0) do={')
    expect(withRadius).toContain('/radius add address=10.0.0.1 secret="s3cr3t-value"')
    for (const l of withRadius.split('\n')) {
      if (l.includes('url=')) expect(l).not.toContain('s3cr3t-value')
      if (l.trimStart().startsWith('/tool fetch')) expect(l).not.toContain('s3cr3t-value')
    }
    expect(validateRouterOsScript(withRadius, { mode: 'serialize' })).toEqual([])
  })
})

describe('the heartbeat is installed as stored source, double-escaped', () => {
  it('derives /ping from the report URL so the two endpoints cannot drift', () => {
    expect(pingUrl(OPTS.reportUrl)).toBe(
      'https://demo.supabase.co/functions/v1/router-provision/ping',
    )
    expect(script).toContain('/router-provision/ping')
  })

  it('the embedded fetch is canonical too - it lives inside source=', () => {
    const line = script.split('\n').find((l) => l.includes('/system script add'))!
    expect(line).toBeTruthy()
    expect(line).toContain('url=')
    expect(line).toContain('http-method=post')
    expect(line).toContain('check-certificate=yes')
    expect(line).toContain('http-data=')
    expect(line).not.toContain('method=POST')
    expect(line).not.toContain('keep-result')
  })
})
