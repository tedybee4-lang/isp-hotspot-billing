// Reproduces EXACTLY what router-provision returns to a CHR on RouterOS 7.24.4,
// so the generated artifact can be inspected and audited offline.
import { writeFileSync } from 'node:fs'
import { buildAccessScript } from '../../supabase/functions/_shared/capabilities.ts'
import { buildDiscoveryScript } from '../../supabase/functions/_shared/discovery.ts'
import { buildCompatibility, parseVersion } from '../../supabase/functions/_shared/compat.ts'

const REPORT = 'https://demo.supabase.co/functions/v1/router-provision/report'
const raw = process.argv[2] ?? '7.24.4'
const arch = process.argv[3] ?? 'x86_64'
const out = process.argv[4] ?? 'tmp-bootstrap.rsc'

const profile = buildCompatibility(raw, arch, 'CHR innotek GmbH VirtualBox')
const parsed = parseVersion(raw)

const body = buildAccessScript({ tag: 'abcd1234', profile, vpn: null })
// The trailer must be generated from the SAME source the edge function uses,
// or this harness drifts from production and audits a file nobody serves. Read
// it straight out of the handler module.
const TRAILER_LINES = [
  '',
  '# --- Report back what this router is ---',
  ':local ispFlowClaimName [/system/identity/get name]',
  ':local ispFlowClaimVer [/system/resource/get version]',
  ':local ispFlowClaimBoard [/system/resource/get board-name]',
  ':put ("ISPFlow: registered as " . $ispFlowClaimName);',
  ':put ("ISPFlow: RouterOS " . $ispFlowClaimVer . " on " . $ispFlowClaimBoard);',
]
const trailer = TRAILER_LINES.concat(profile.rest
  ? ':put "ISPFlow: HTTPS management is available on port 8080.";'
  : profile.versionKnown
    ? ':put "ISPFlow: this RouterOS version has no REST; the panel will use the API.";'
    : ':put "ISPFlow: RouterOS version not reported; the panel will use the API.";',
'').join('\n')
const discovery = buildDiscoveryScript({
  reportUrl: REPORT,
  token: 'd'.repeat(48),
  major: parsed?.major ?? (profile.rest ? 7 : 6),
  tag: 'abcd1234',
})

const file = body + trailer + (discovery ? '\n' + discovery : '')
writeFileSync(out, file)
console.log(`profile: rest=${profile.rest} wg=${profile.wireGuard} known=${profile.versionKnown}`)
console.log(`major sent to discovery: ${parsed?.major ?? (profile.rest ? 7 : 6)}`)
console.log(`wrote ${out}: ${file.length} bytes, ${file.split('\n').length} lines`)