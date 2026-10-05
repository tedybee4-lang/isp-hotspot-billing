// Mints a real single-use provisioning session and prints the exact command the
// panel would hand the operator, built by the SAME module the panel uses.
import { readFileSync } from 'node:fs'
import { buildProvisioningCommand } from './supabase/functions/_shared/capabilities.ts'

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

const [isp] = await (await api('isps?select=id&limit=1')).json()
if (!isp?.id) { console.error('no isp row'); process.exit(1) }

const session = await (await api('provisioning_sessions', {
  method: 'POST',
  body: JSON.stringify({ isp_id: isp.id, label: 'CHR handoff', role: 'hotspot' }),
})).json()

const token = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, '0')).join('')
const hash = [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
)].map((b) => b.toString(16).padStart(2, '0')).join('')

await api('provisioning_tokens', {
  method: 'POST',
  body: JSON.stringify({
    session_id: session[0].id,
    isp_id: isp.id,
    token_hash: hash,
    purpose: 'claim',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }),
})

const command = buildProvisioningCommand({
  claimUrl: `${URL_}/functions/v1/router-provision`,
  token,
})

console.log('')
console.log('# session : ' + session[0].id)
console.log('# expires : 30 minutes from now (single use)')

// --- prove the command end to end -----------------------------------------
// Reproduce exactly what the router will send: version "7.24.4" through the
// corrected :find / :pick algorithm, then fetch with THIS token and validate
// the bytes. If this passes, the CHR does the same thing.
const pick = (s, start, end) => s.slice(start, end)
const find = (s, needle, after) => {
  const i = s.indexOf(needle, after + 1)
  if (i < 0) throw new Error('no second dot')
  return i
}
const routerVm = (rawVersion) => {
  const v = `${rawVersion}..`
  return pick(v, 0, find(v, '.', find(v, '.', -1)))
}

const { validateRouterOsScript } = await import('./src/test/routeros-validate.ts')
console.log('')
console.log('# --- verification (each probe mints its own throwaway session, so the token below stays unused) ---')

// A throwaway session per probe, so proving the response does not burn the one
// you will paste - the claim endpoint consumes its token on first use.
for (const rawVersion of ['7.24.4', '7.9.2', '7.24', '6.49.10 (long-term)']) {
  // Fresh single-use token per request: the claim endpoint consumes it.
  const s = await (await api('provisioning_sessions', {
    method: 'POST',
    body: JSON.stringify({ isp_id: isp.id, label: `probe ${rawVersion}`, role: 'hotspot' }),
  })).json()
  const t = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  const h = [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)),
  )].map((b) => b.toString(16).padStart(2, '0')).join('')
  await api('provisioning_tokens', {
    method: 'POST',
    body: JSON.stringify({
      session_id: s[0].id, isp_id: isp.id, token_hash: h, purpose: 'claim',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  })

  const vm = routerVm(rawVersion)
  const u = `${URL_}/functions/v1/router-provision?token=${t}&vm=${vm}&arch=x86_64`
  const res = await fetch(u)
  const body = await res.text()
  const bytes = Buffer.byteLength(body, 'utf8')
  const serialize = body.includes(':serialize to=json')
  // `:serialize to=json` exists only from RouterOS 7.13, so below that - and on
  // every RouterOS 6 build - hand-escaping is CORRECT, not a regression.
  // Flagging :replace on a 7.9 response would be a false alarm.
  const [maj, min] = rawVersion.split('.').map(Number)
  const wantsSerialize = maj > 7 || (maj === 7 && min >= 13)
  const issues = serialize ? validateRouterOsScript(body, { mode: 'serialize' }) : []
  const forbidden = (wantsSerialize
    ? [':replace', 'JSON.stringify', 'http-method', 'keep-result=no', '$identity']
    : ['JSON.stringify', 'http-method', 'keep-result=no', '$identity'])
    .filter((s2) => body.includes(s2))
  const verdict = wantsSerialize
    ? (serialize && issues.length === 0 && forbidden.length === 0 ? 'OK ' : 'BAD')
    : (serialize ? 'BAD' : 'OK ')  // pre-7.13 must NOT emit :serialize
  console.log(
    `#   ${verdict} ${rawVersion.padEnd(22)} -> vm=${vm.padEnd(6)} HTTP ${res.status} ` +
    `${String(bytes).padStart(6)} B  ${serialize ? 'SERIALIZE' : 'escape   '}  ` +
    `expected=${wantsSerialize ? 'SERIALIZE' : 'escape   '}  ` +
    `validator=${serialize ? (issues.length ? issues.length + ' issues' : 'clean') : 'n/a'}  ` +
    `forbidden=${forbidden.length ? forbidden.join(',') : 'none'}`,
  )
}

console.log('')
console.log('# Source version line the CHR will read:')
console.log('#   /system/resource/get version  ->  e.g. 7.24.4')
console.log('')
console.log(command)
console.log('')
console.log('# The token above is still unused and is valid for 30 minutes.')
