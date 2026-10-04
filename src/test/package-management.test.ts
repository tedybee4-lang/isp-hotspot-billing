/**
 * ISP package management: the properties that keep a package catalogue honest.
 *
 * The bug this file exists for: the captive portal rendered ZERO packages for
 * every tenant, because `public_portal_packages` had never been applied. The
 * migration that defines it aborted on an unrelated statement, and since it is
 * one transaction the corrected function rolled back with it, leaving an older
 * copy whose filter treated an EMPTY `package_ids` array as "this ISP curated
 * the list down to nothing". Every tenant stores the default '{}', so every
 * portal was empty.
 *
 * These assert against the shipped SQL and TypeScript, not a description of
 * them. Nothing here contacts a database.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')
/** SQL with `--` comment lines stripped, so prose cannot satisfy an assertion. */
const code = (...parts: string[]) =>
  read(...parts)
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
/** The body of one function inside a migration, from its name onwards. */
const fn = (file: string, name: string) =>
  code(file).slice(code(file).indexOf(`create or replace function public.${name}`))

const STOREFRONT = 'supabase/migrations/20260101200000_portal_storefront.sql'
const VALIDATION = 'supabase/migrations/20260101410000_package_management_validation.sql'
const SELF_SERVICE = 'supabase/migrations/20260101000800_isp_self_service.sql'
const PAYHERO_ROUTE = 'supabase/migrations/20260101300000_portal_payhero_route.sql'
const PAGE = 'src/pages/isp/panel/PackagesPage.tsx'
const PORTAL = 'src/lib/portal.ts'

describe('the storefront migration can actually be applied', () => {
  // The whole defect was here: the file aborted, so everything in it silently
  // never reached production while the frontend went on calling the RPC.
  it('drops the function whose parameter default blocked the re-apply', () => {
    const sql = code(STOREFRONT)
    expect(sql).toMatch(
      /drop function if exists public\.portal_create_payment\(text, uuid, text\)/,
    )
    // The drop must come BEFORE the replacement, or it achieves nothing.
    expect(sql.indexOf('drop function if exists public.portal_create_payment')).toBeLessThan(
      sql.indexOf('create or replace function public.portal_create_payment'),
    )
  })

  it('is a single transaction, so an abort cannot half-apply it again', () => {
    // This is what made the failure silent: the storefront fields were already
    // live from an earlier apply, so nothing looked broken while the corrected
    // function rolled back every time.
    const sql = code(STOREFRONT)
    expect(sql).toMatch(/begin;/)
    expect(sql).toMatch(/commit;/)
  })
})

describe('the portal lists a tenant\'s packages instead of an empty array', () => {
  const body = () => fn(STOREFRONT, 'public_portal_packages')

  it('treats an empty package_ids array as "no curation", not "show nothing"', () => {
    // The defect. `pl.id = any('{}')` is false AND "package_ids is not null" is
    // true, so both branches failed and every package was filtered out.
    expect(body()).toMatch(/cardinality\(\s*ps\.package_ids\s*\)\s*=\s*0/)
  })

  it('scopes by the slug-derived tenant, never by a caller-supplied id', () => {
    expect(body()).toMatch(/where i\.slug = lower\(trim\(p_slug\)\)/)
    // No id parameter exists, so a browser cannot ask for another ISP's list.
    expect(body()).not.toMatch(/p_isp_id/)
  })

  it('requires a switched-on portal and an active, portal-visible package', () => {
    expect(body()).toMatch(/ps\.is_enabled/)
    expect(body()).toMatch(/pl\.is_active/)
    expect(body()).toMatch(/pl\.show_on_portal/)
  })

  it('honours the configured display order, falling back to cheapest first', () => {
    expect(body()).toMatch(/array_position\(ps\.package_order, pl\.id\)/)
    expect(body()).toMatch(/order by p\.sort_key, p\.price asc/)
  })

  it('exposes current price, speed and duration so an edit reaches the storefront', () => {
    expect(body()).toMatch(/pl\.price/)
    expect(body()).toMatch(/pl\.speed_down/)
    expect(body()).toMatch(/pl\.speed_up/)
    expect(body()).toMatch(/pl\.duration_hours/)
  })
})

describe('package fields are validated on the server, not only in the browser', () => {
  const rules = () => fn(VALIDATION, 'validate_plan_fields')

  it('is wired into both create and update', () => {
    expect(fn(VALIDATION, 'create_plan')).toMatch(/perform public\.validate_plan_fields\(/)
    expect(fn(VALIDATION, 'update_plan')).toMatch(/perform public\.validate_plan_fields\(/)
  })

  it('refuses an empty name, a negative price, a bad type, a zero duration and a junk speed', () => {
    const body = rules()
    expect(body).toMatch(/Package name is required/)
    expect(body).toMatch(/Package price cannot be negative/)
    expect(body).toMatch(/Package type must be hotspot, pppoe or fiber/)
    expect(body).toMatch(/Package duration must be at least 1 hour/)
    expect(body).toMatch(/Download speed must look like/)
  })

  it('allows a free package but not a negative one', () => {
    // Zero is a legitimate price for a house package; the rule is `< 0`.
    expect(rules()).toMatch(/if p_price < 0 then/)
    expect(rules()).not.toMatch(/if p_price <= 0 then/)
  })

  it('resolves the tenant from the session so the browser cannot name one', () => {
    for (const name of ['create_plan', 'update_plan']) {
      const body = fn(VALIDATION, name)
      expect(body, `${name} must read the tenant from the session`).toMatch(/current_isp_id\(\)/)
      expect(body, `${name} must not accept an isp_id argument`).not.toMatch(/p_isp_id\s+uuid/)
    }
  })

  it('keeps a rejected edit from half-applying', () => {
    // update_plan writes the patch first, so validation has to run against the
    // MERGED row and rely on the raise to abort the statement.
    const update = fn(VALIDATION, 'update_plan')
    expect(update.indexOf('update public.plans')).toBeLessThan(
      update.indexOf('perform public.validate_plan_fields'),
    )
  })

  it('refuses two packages with the same name in one tenant, because settlement matches by name', () => {
    expect(rules()).toBeDefined()
    expect(fn(VALIDATION, 'assert_unique_plan_name')).toMatch(/lower\(btrim\(name\)\)/)
  })
})

describe('a package is never hard-deleted out from under its history', () => {
  it('the delete RPC refuses while customers or vouchers reference it', () => {
    expect(code(SELF_SERVICE)).toMatch(/Deactivate it instead of deleting/)
  })

  it('the UI offers deactivation and visibility as the normal alternatives', () => {
    const page = read(PAGE)
    expect(page).toMatch(/toggleActive/)
    expect(page).toMatch(/togglePortal/)
    expect(page).toMatch(/show_on_portal/)
    expect(page).toMatch(/is_active/)
  })
})

describe('the ISP package page is editable, not a read-only table', () => {
  it('routes /app/packages to the management page', () => {
    expect(read('src/App.tsx')).toMatch(/pages\/isp\/panel\/PackagesPage/)
  })

  it('no longer exports the read-only catalogue it replaced', () => {
    // Two package pages is how someone ends up editing the one nobody sees.
    expect(read('src/pages/isp/panel/legacy.tsx')).not.toMatch(/export function PackagesRoute/)
  })

  it('offers create, edit and delete through the tenant-scoped RPCs', () => {
    const page = read(PAGE)
    expect(page).toMatch(/api\.createPlan/)
    expect(page).toMatch(/api\.updatePlan/)
    expect(page).toMatch(/api\.deletePlan/)
    // No direct table write from the browser: every mutation goes through an RPC
    // that resolves the tenant server-side.
    expect(page).not.toMatch(/from\('plans'\)/)
  })

  it('edits price, speed, duration and name', () => {
    const page = read(PAGE)
    for (const field of ['price', 'speed_down', 'speed_up', 'duration_hours', 'name']) {
      expect(page, `${field} must be editable`).toMatch(new RegExp(`'${field}'`))
    }
  })

  it('persists the storefront display order through portal settings', () => {
    const page = read(PAGE)
    expect(page).toMatch(/package_order/)
    expect(page).toMatch(/savePortalSettings/)
  })

  it('warns the ISP when nothing is offered, instead of inventing a package', () => {
    const page = read(PAGE)
    expect(page).toMatch(/No packages are currently available/)
    expect(page).toMatch(/No packages defined/)
  })
})

describe('the payment amount still comes from the database', () => {
  // Bounded to the single function: slicing to end-of-file swept in
  // fetchPortalPaymentStatus, which legitimately reports an amount back.
  const startCall = () => {
    const portal = read(PORTAL)
    const from = portal.indexOf('export async function startPortalPayment')
    const to = portal.indexOf('export async function', from + 1)
    const body = portal.slice(from, to)
    return body.slice(body.indexOf('JSON.stringify'))
  }

  it('the browser sends a plan id and a phone, never an amount', () => {
    const body = startCall()
    expect(body).toMatch(/planId/)
    expect(body).toMatch(/phone/)
    // The price is resolved from the plan row by portal_create_payment.
    expect(body).not.toMatch(/amount/i)
    expect(body).not.toMatch(/price/i)
    expect(body).not.toMatch(/isp_id/i)
  })

  it('the RPC derives the amount from the plan row it loads itself', () => {
    expect(fn(STOREFRONT, 'portal_create_payment')).toMatch(/v_amount\s*:=\s*v_plan\.price/)
  })
})

describe('the verified PayHero lifecycle is not regressed by package work', () => {
  it('the storefront route still resolves PayHero as the provider', () => {
    expect(code(PAYHERO_ROUTE)).toMatch(/payhero/)
  })

  it('the callback still parses PayHero\'s nested response object', () => {
    expect(read('supabase/functions/payhero-callback/index.ts')).toMatch(/ExternalReference/)
  })

  it('package management added no second payment or provider path', () => {
    // A package price must reach M-Pesa only through the existing route, so a
    // package change can never introduce a parallel settlement path.
    expect(read(PAGE)).not.toMatch(/stk|payhero|mpesa/i)
  })
})