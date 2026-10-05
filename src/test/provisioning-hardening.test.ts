/**
 * Deployment-level assertions about the RADIUS secret and the hardening
 * migration.
 *
 * These read the SQL as deployed. They are the only tests in this suite that
 * can catch a browser being able to SELECT a secret column, because that is a
 * property of the GRANT, not of any TypeScript.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), 'utf8')

const HARDENING = 'supabase/migrations/20260101700000_provisioning_hardening.sql'
const STAGES = 'worker/src/stages.ts'
const DB = 'worker/src/db.ts'
const PROVISION_FN = 'supabase/functions/router-provision/index.ts'
const DATA = 'src/lib/data.ts'

describe('the RADIUS secret can never reach a browser', () => {
  it('is stored encrypted, never in plaintext', () => {
    const sql = read(HARDENING)
    // The column is ciphertext, and the RPC that writes it is told so.
    expect(sql).toMatch(/secret_ciphertext\s+text/)
    expect(sql).toMatch(/set_radius_nas_secret/)
  })

  it('is excluded from the authenticated role by a COLUMN grant', () => {
    const sql = read(HARDENING)
    // A row-level RLS policy says nothing about columns. Without this, any
    // authenticated user in the tenant could `select secret_ciphertext`.
    expect(sql).toMatch(/revoke select on public\.radius_nas from authenticated/i)
    // And the safe columns are re-granted by name, so the panel still works.
    expect(sql).toMatch(/grant select \([\s\S]*?nas_identifier[\s\S]*?\)/i)
    expect(sql).not.toMatch(/grant select \([^)]*secret_ciphertext/i)
  })

  it('is readable only by the service role', () => {
    const sql = read(HARDENING)
    for (const fn of ['radius_nas_secret_for_node', 'set_radius_nas_secret']) {
      // Revoked from everyone including `authenticated`, then granted to
      // service_role and nothing else.
      expect(sql).toContain(`revoke all on function public.${fn}`)
      expect(sql).toContain(`grant execute on function public.${fn}`)
    }
    // The revoke block for each must name authenticated explicitly.
    const revokes = sql.match(/revoke all on function public\.[a-z_]+[^;]+;/gi) ?? []
    expect(revokes.length).toBeGreaterThanOrEqual(2)
    for (const r of revokes) expect(r).toMatch(/authenticated/i)
  })

  it('is scoped by node AND tenant, so a tampered job cannot read another', () => {
    const sql = read(HARDENING)
    const fn = sql.slice(sql.indexOf('radius_nas_secret_for_node'))
    // Both conditions, not either: node_id alone would let a job row name any
    // router in the platform.
    expect(fn.slice(0, 600)).toMatch(/n\.node_id\s*=\s*p_node_id/)
    expect(fn.slice(0, 600)).toMatch(/n\.isp_id\s*=\s*p_isp_id/)
    expect(fn.slice(0, 600)).toMatch(/nd\.isp_id\s*=\s*p_isp_id/)
  })

  it('is decrypted only in the worker, in memory', () => {
    const db = read(DB)
    expect(db).toMatch(/decryptSecret\(cipher, this\.cfg\.credentialKey\)/)
    // Never written back to a session row, a stage detail or a result.
    expect(db).not.toMatch(/radiusSecret:\s*cipher/)
  })

  it('never travels through the browser API surface', () => {
    const data = read(DATA)
    // The write endpoint exists...
    expect(data).toMatch(/saveRadiusSecret/)
    // ...and there is deliberately no getter that returns the value.
    expect(data).not.toMatch(/export async function (get|fetch|read)RadiusSecret\b/)
    // The status endpoint exposes a boolean, not the secret.
    expect(data).toMatch(/configured:\s*boolean/)
  })

  it('is never echoed by the Edge Function that accepts it', () => {
    const fn = read(PROVISION_FN)
    expect(fn).toMatch(/encryptSecret\(secret\)/)
    // The success response must not carry the value or a fragment of it.
    const ok = fn.slice(fn.indexOf("stored: true,"), fn.indexOf("stored: true,") + 300)
    expect(ok).not.toMatch(/secret:/)
  })

  it('is redacted even if a stage result ever contained it', () => {
    const stages = read(STAGES)
    // Belt and braces: the name-based redaction covers `secret` regardless of
    // which call site produced it, including one added later.
    expect(stages).toMatch(/'secret'/)
    expect(stages).toMatch(/\[redacted\]/)
  })
})

describe('the static package kind is additive and stays tenant-scoped', () => {
  it('adds static to the constraint rather than replacing the table', () => {
    const sql = read(HARDENING)
    expect(sql).toMatch(/kind in \('hotspot','fiber','pppoe','static'\)/)
    // Every pre-existing kind is still valid: no plan is rejected by this.
    expect(sql).toMatch(/add constraint plans_kind_check/i)
  })

  it('keeps the copy function tenant-gated', () => {
    const sql = read('supabase/migrations/20260101610000_provisioning_stage_engine.sql')
    const fn = sql.slice(sql.indexOf('copy_router_plans'))
    // The tenant comparison runs before any plan row is read.
    expect(fn.slice(0, 3000)).toMatch(/v_source_isp\s*<>\s*v_target_isp/)
    expect(fn.slice(0, 3000)).toMatch(/only copy plans from another router of your own ISP/i)
  })
})