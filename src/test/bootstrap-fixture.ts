// No `vitest` import here on purpose: gen-bootstrap.ts runs this through
// vite-node to write a golden fixture, and importing vitest outside a vitest
// run throws.
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