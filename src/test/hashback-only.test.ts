import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const has = (...p: string[]) => existsSync(join(ROOT, ...p))

/**
 * Strip comments so an assertion about CODE cannot be satisfied by prose that
 * mentions the same word. Several of these files deliberately explain that
 * Daraja was removed; matching the raw text would either fail on the explanation
 * or, worse, "find" the bug inside a comment.
 */
const code = (...p: string[]) =>
  read(...p)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')
      && !l.trim().startsWith('/*') && !l.trim().startsWith('#'))
    .join('\n')

const UI = [
  'src/pages/admin/IspDetail.tsx',
  'src/pages/admin/PlatformPayments.tsx',
  'src/pages/isp/settings/Payment.tsx',
]

/**
 * HashBack is the only M-Pesa provider.
 *
 * These stop a second payment system creeping back in. Each fails if a Daraja
 * route, credential field, fallback or fake-success helper reappears on a path
 * a customer can reach.
 */
describe('HashBack is the only M-Pesa provider', () => {
  it('offers no Daraja payment mode to the browser', () => {
    const src = code('src', 'lib', 'data.ts')
    expect(src).not.toMatch(/platform_daraja/)
    expect(src).not.toMatch(/own_daraja/)
    // The type itself must not admit them either, or a call site can still
    // compile against a mode the server will refuse.
    expect(src).toMatch(/export type PaymentMode = 'manual_till'/)
  })

  it('never calls safaricom from any application code', () => {
    for (const f of ['src/lib/data.ts', 'src/lib/payments.ts', ...UI]) {
      const src = code(f)
      // Scoped to ROUTING, not the word: a user-facing string may legitimately
      // say "Daraja was removed" to help an operator who is migrating.
      expect(src, `${f} still calls Safaricom`).not.toMatch(/safaricom\.co\.ke/i)
      expect(src, `${f} still selects a Daraja mode`)
        .not.toMatch(/platform_daraja|own_daraja/)
    }
  })

  it('has no Daraja credential form anywhere in the UI', () => {
    // Consumer key / secret / passkey were the three write-only secret inputs.
    for (const f of UI) {
      const src = code(f)
      expect(src, `${f} still has a consumer-key input`).not.toMatch(/consumer_key/)
      expect(src, `${f} still has a consumer-secret input`).not.toMatch(/consumer_secret/)
      // A prose mention is fine (the screen points at HashBack); an INPUT or
      // a save payload carrying one is not.
      expect(src, `${f} still sends a passkey to the server`)
        .not.toMatch(/mpesa_passkey|setPasskey|passkey\s*[:=]/)
    }
  })

  it('deletes the Daraja client shim rather than leaving it callable', () => {
    // The shim delegated to HashBack but still exported queryStkPushStatus,
    // which returned a hard-coded success. A function that always reports
    // success is worse than no function: a caller cannot tell it is fake.
    expect(has('src', 'services', 'darajaApi.ts')).toBe(false)
  })

  it('answers 410 from stk-push and implements nothing else', () => {
    const src = code('supabase', 'functions', 'stk-push', 'index.ts')
    expect(src).toMatch(/410/)
    expect(src).toMatch(/hashback-stk/)
    // No OAuth, no STK request, no credential read: the implementation is gone,
    // not merely unreachable behind a guard.
    expect(src).not.toMatch(/oauth\/v1\/generate/)
    expect(src).not.toMatch(/stkpush\/v1\/processrequest/)
    expect(src).not.toMatch(/mpesa_consumer_key|mpesa_passkey/)
  })


  it('does not forward a browser-supplied amount', () => {
    // The server resolves the authoritative figure from the invoice or plan.
    // Forwarding one is how "pay KSh 1 for a KSh 1,500 package" happens.
    const full = read('src', 'lib', 'data.ts')
    const body = full.slice(full.indexOf('export async function initiateStkPush'))
    const fn = body.slice(0, body.indexOf('\n}'))
    expect(fn).not.toMatch(/amount:\s*input\.amount/)
  })

  it('refuses a Daraja mode at the database, not only in the UI', () => {
    const sql = read('supabase', 'migrations', '20260101120000_daraja_cutover.sql')
    expect(sql).toMatch(/isp_payment_configs_no_daraja/)
    expect(sql).toMatch(/payments_no_daraja_provider/)
    expect(sql).toMatch(/Daraja payment modes have been removed/)
    // The cutover must not have dropped the historical columns.
    expect(sql).not.toMatch(/drop\s+(table|column)/i)
  })

  it('keeps the retired enum labels for history', () => {
    // Removing an enum label means recreating the type and re-adding every row.
    // The guarantee is that the value cannot be WRITTEN, not that it vanished.
    const sql = read('supabase', 'migrations', '20260101120000_daraja_cutover.sql')
    expect(sql).toMatch(/labels remain/i)
  })

  it('never exposes a payment secret to the browser', () => {
    for (const f of ['src/lib/payments.ts', 'src/pages/admin/PlatformHashBack.tsx',
      'src/pages/isp/settings/HashBackPayments.tsx']) {
      const src = code(f)
      // Status is booleans and status strings only.
      expect(src, `${f} exposes a raw api key`).not.toMatch(/api_key_encrypted/)
      expect(src, `${f} exposes a webhook secret`).not.toMatch(/webhook_secret_encrypted/)
      expect(src, `${f} is not NEXT_PUBLIC`).not.toMatch(/NEXT_PUBLIC/)
    }
  })

  it('resolves the tenant server-side with no ispId parameter', () => {
    const src = read('src', 'lib', 'payments.ts')
    // A browser-supplied isp_id is how ISP A drives ISP B's channel.
    expect(src).toMatch(/deliberately no ispId parameter/i)
    expect(src).not.toMatch(/fetchMyPaymentChannel\s*\(\s*ispId/)
  })

  it('does not invent a HashBack endpoint', () => {
    // The adapter's endpoint table is asserted against the researched API in
    // its own test; this guards the application from calling anything outside it.
    const adapter = read('supabase', 'functions', '_shared', 'hashback.ts')
    for (const path of ['initiatestk', 'transactionstatus', 'pullapi',
      'linkaccount', 'registerwebhook']) {
      expect(adapter, `adapter is missing ${path}`).toContain(path)
    }
  })

  it('ships no Daraja setup documentation', () => {
    // A guide telling an operator to paste a consumer key into the app is an
    // active Daraja route even though no code reads it.
    expect(has('DARAJA_SETUP.md')).toBe(false)
    for (const f of ['README.md', 'DEPLOYMENT.md', 'SETUP_CHECKLIST.md']) {
      expect(read(f), `${f} still instructs Daraja setup`)
        .not.toMatch(/VITE_DARAJA|developer\.safaricom/i)
    }
  })
  it('has no Daraja callback function left to settle payments', () => {
    expect(has('supabase', 'functions', 'stk-callback')).toBe(false)
  })

  it('routes the customer payment flow through hashback-stk', () => {
    const src = code('src', 'lib', 'data.ts')
    expect(src).toMatch(/functionsUrl\('hashback-stk'\)/)
    expect(src).not.toMatch(/functionsUrl\('stk-push'\)/)
  })
})
