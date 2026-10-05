import { describe, expect, it } from 'vitest'
import { buildAccessScript } from '../../supabase/functions/_shared/capabilities.ts'
import { buildDiscoveryScript } from '../../supabase/functions/_shared/discovery.ts'
import { buildCompatibility, parseVersion } from '../../supabase/functions/_shared/compat.ts'
import { validateRouterOsScript } from './routeros-validate'

export const CLAIM = 'https://demo.supabase.co/functions/v1/router-provision'
const REPORT = `${CLAIM}/report`
export const TOKEN = 'd'.repeat(48)
const TAG = 'abcd1234'

/**
 * The complete bootstrap exactly as router-provision returns it: access script,
 * claim trailer, discovery survey. The trailer is inline here because the
 * handler assembles it; it is asserted here so the same file is validated.
 */
export function bootstrap(rawVersion: string | null, arch: string): string {
  const profile = buildCompatibility(rawVersion, arch, null)
  const parsed = parseVersion(rawVersion ?? '')
  const access = buildAccessScript({ tag: TAG, profile, vpn: null })
  const trailer = [
    '',
    ':local ispFlowClaimName [/system/identity/get name]',
    ':local ispFlowClaimVer [/system/resource/get version]',
    ':local ispFlowClaimBoard [/system/resource/get board-name]',
    ':put ("ISPFlow: registered as " . $ispFlowClaimName);',
    ':put ("ISPFlow: RouterOS " . $ispFlowClaimVer . " on " . $ispFlowClaimBoard);',
    profile.rest
      ? ':put "ISPFlow: HTTPS management is available on port 8080.";'
      : profile.versionKnown
        ? ':put "ISPFlow: this RouterOS version has no REST; the panel will use the API.";'
        : ':put "ISPFlow: RouterOS version not reported; the panel will use the API.";',
  ].join('\n')
  const discovery = buildDiscoveryScript({
    reportUrl: REPORT,
    token: TOKEN,
    major: parsed?.major ?? (profile.rest ? 7 : 6),
    tag: TAG,
  })
  return `${access}\n${trailer}\n${discovery}`
}

/** Compact failure message: the rules, not 1700 lines of script. */
export function rules(script: string): string {
  const found = validateRouterOsScript(script)
  return [...new Set(found.map((i) => `${i.rule}@L${i.line}`))].join(', ')
}

describe('the validator itself rejects what broke real hardware', () => {
  it.each([
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
    // The only remaining finding is the deliberately unclosed outer brace; what
    // matters is that no `undefined-variable` is reported.
    const found = validateRouterOsScript(script)
    expect(found.some((i) => i.rule === 'undefined-variable')).toBe(false)
  })
})