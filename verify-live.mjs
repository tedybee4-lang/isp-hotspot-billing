// Acceptance check for the LIVE production endpoint.
//
// mints a single-use provisioning session exactly the way the panel does, then
// fetches the bootstrap the way the MikroTik does (token + vm + arch, nothing
// else) and reports on the bytes that actually came back. The HTTP response is
// the acceptance artifact; source and tests only predict it.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(process.cwd() + '/.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const URL_ = env.VITE_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const CLAIM = `${URL_}/functions/v1/router-provision`

const ALLOW = [
  'ISPFlow-BOOTSTRAP-GENERATOR-528C90',
  'ISPFlow-ROUTEROS7-SERIALIZE-GENERATOR',
  ':serialize to=json',
  'method=POST',
  'check-certificate=yes',
  'http-header-field="Content-Type:application/json"',
]
const DENY = [
  '[:replace',
  ':replace',
  'JSON.stringify',
  'JSON.parse',
  'http-method',
  'keep-result=no',
  '$identity',
  '$version',
  '$board-name',
  ' standalone do={',
]

const step = (m) => console.log(`\n--- ${m}`)

step('1. mint a fresh single-use session')
// The RPC resolves scope from auth.uid(), which the service role does not have,
// so it raises "No ISP in scope". These are the same two rows the RPC inserts,
// made directly with the service role: one session, one hashed token.
const api = (path, init = {}) => fetch(`${URL_}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...init.headers,
  },
})

const isps = await (await api('isps?select=id&limit=1')).json()
if (!isps?.[0]?.id) { console.error('no isp row found'); process.exit(1) }
const ispId = isps[0].id

const sess = await (await api('provisioning_sessions', {
  method: 'POST',
  body: JSON.stringify({ isp_id: ispId, label: 'CHR acceptance check', role: 'hotspot' }),
})).json()

const token = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, '0')).join('')
const tokenHash = [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
)].map((b) => b.toString(16).padStart(2, '0')).join('')

await api('provisioning_tokens', {
  method: 'POST',
  body: JSON.stringify({
    session_id: sess[0].id,
    isp_id: ispId,
    token_hash: tokenHash,
    purpose: 'claim',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }),
})
console.log(`  session=${sess[0].id}  token=${token.slice(0, 8)}…  isp=${ispId}`)

step('2. download exactly as the MikroTik does')
const url = `${CLAIM}?token=${token}&vm=7.24&arch=x86_64`
const res = await fetch(url, { headers: { Accept: 'text/plain' } })
const body = await res.text()
const bytes = Buffer.byteLength(body, 'utf8')
console.log(`  HTTP ${res.status}  content-type=${res.headers.get('content-type')}`)
console.log(`  ${bytes} bytes  ${body.split('\n').length} lines  (${(bytes / 1024).toFixed(1)} KiB)`)

step('3. fingerprint')
const missing = ALLOW.filter((s) => !body.includes(s))
const present = DENY.filter((s) => body.includes(s))
for (const s of ALLOW) console.log(`  ${body.includes(s) ? 'PRESENT ' : 'MISSING '} ${s}`)
for (const s of present) console.log(`  FORBIDDEN PRESENT ${s}`)

step('4b. how the router actually computes vm, end to end')
// The command the operator pastes builds `vm` as [:pick $ver 0 1] "." [:pick $ver 2 2].
// If :pick's second argument is a stop index rather than a length, minor comes back
// empty, vm arrives as "7." and the server cannot determine a version - which sends
// the router down the hand-escaping path even on a correct deploy.
for (const probe of ['7.24', '7.', '']) {
  const t = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  const h = [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)),
  )].map((b) => b.toString(16).padStart(2, '0')).join('')
  const s = await (await api('provisioning_sessions', {
    method: 'POST',
    body: JSON.stringify({ isp_id: ispId, label: `probe vm=${JSON.stringify(probe)}`, role: 'hotspot' }),
  })).json()
  await api('provisioning_tokens', {
    method: 'POST',
    body: JSON.stringify({
      session_id: s[0].id, isp_id: ispId, token_hash: h, purpose: 'claim',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  })
  const u = probe === '' ? `${CLAIM}?token=${t}` : `${CLAIM}?token=${t}&vm=${probe}&arch=x86_64`
  const r = await fetch(u)
  const b = await r.text()
  const n = Buffer.byteLength(b, 'utf8')
  console.log(
    `  vm=${JSON.stringify(probe).padEnd(6)} -> HTTP ${r.status} ` +
    `${String(n).padStart(6)} bytes  ` +
    `${b.includes(':serialize to=json') ? 'SERIALIZE' : 'ESCAPE   '}  ` +
    `${b.includes(':replace') ? 'has:replace' : 'no:replace'}`,
  )
}

step('4. static validation')
const { validateRouterOsScript } = await import('./src/test/routeros-validate.ts')
const issues = validateRouterOsScript(body, { mode: 'serialize' })
if (issues.length) {
  for (const i of issues.slice(0, 20)) console.log(`  L${i.line} [${i.rule}] ${i.message}`)
} else console.log('  clean')

const ok = res.status === 200 && missing.length === 0 && present.length === 0
  && issues.length === 0
  && bytes < 40 * 1024 && bytes > 20 * 1024

step('RESULT')
console.log(ok
  ? `PASS  production returns the corrected generator: ${bytes} bytes`
  : `FAIL  res=${res.status} missing=${missing.length} forbidden=${present.length} issues=${issues.length}`)

if (process.argv.includes('--save')) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('live-production-bootstrap.rsc', body)
  console.log('wrote live-production-bootstrap.rsc')
}
process.exit(ok ? 0 : 1)
