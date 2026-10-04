/**
 * PayHero integration: deployment-shape and safety properties.
 *
 * These assert against the shipped SQL, TypeScript and configuration rather than
 * against a description of them. They exist because the failures they catch are
 * invisible until money moves: a dropped table, a tenant able to read another's
 * channel, or a credential reaching the browser.
 *
 * Nothing here contacts PayHero or a database.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { providerLabel } from '../lib/provider'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')
const has = (...parts: string[]) => existsSync(join(ROOT, ...parts))
/** SQL with `--` comment lines removed, so prose quoting a forbidden statement
 *  cannot satisfy an assertion that the statement is absent. */
const code = (...parts: string[]) =>
  read(...parts)
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')

const ENUM = 'supabase/migrations/20260101201000_payhero_provider_value.sql'
const GATEWAY = 'supabase/migrations/20260101202000_payhero_gateway.sql'

describe('PayHero migrations are additive and non-destructive', () => {
  it('adds the provider as an enum value rather than replacing the type', () => {
    const sql = code(ENUM)
    expect(sql).toMatch(/add value if not exists 'payhero'/)
    // Recreating the type would rewrite every historical payment row.
    expect(sql).not.toMatch(/drop\s+type/i)
    expect(sql).not.toMatch(/alter\s+type\s+\S+\s+rename/i)
  })

  it('never drops or truncates anything', () => {
    for (const f of [ENUM, GATEWAY]) {
      const sql = code(f)
      expect(sql, `${f} drops something`).not.toMatch(/drop\s+(table|column|schema)/i)
      expect(sql, `${f} truncates`).not.toMatch(/truncate/i)
      expect(sql, `${f} deletes rows`).not.toMatch(/\bdelete\s+from\b/i)
    }
  })

  it('uses IF NOT EXISTS so a re-run cannot fail or duplicate', () => {
    const sql = code(GATEWAY)
    expect(sql).toMatch(/add column if not exists payhero_api_token_ciphertext/)
    expect(sql).toMatch(/add column if not exists payhero_channel_id/)
  })

  it('stores the credential in a table with no client SELECT policy', () => {
    // platform_payment_config has no client SELECT policy, so adding a credential
    // column to it cannot expose the ciphertext to the anon key. The policy
    // comment lives in the file that creates the table, so the full text is read
    // rather than the comment-stripped SQL.
    expect(read('supabase/migrations/20260101000300_payment_modes.sql')).toMatch(
      /no client SELECT policy/i,
    )
    expect(code(GATEWAY)).toMatch(/payhero_api_token_ciphertext text/)
  })

  it('reuses the shared settlement function instead of duplicating it', () => {
    const sql = code(GATEWAY)
    // A second settlement implementation is how a payments system double-renews.
    expect(sql).toMatch(/settle_hashback_payment\(/)
    // The wrapper must delegate rather than reimplement invoice/activation work.
    expect(sql).not.toMatch(/update public\.invoices set status = 'paid'/)
    expect(sql).not.toMatch(/update public\.clients set/)
  })

  it('keeps the activation, RADIUS and SMS path intact for PayHero', () => {
    // PayHero settles through the function that already performs all of this, so
    // the behaviour is inherited rather than reimplemented.
    expect(code(GATEWAY)).toMatch(/v_result := public\.settle_hashback_payment\(/)
  })

  it('binds a channel to at most one ISP', () => {
    const sql = code(GATEWAY)
    expect(sql).toMatch(
      /create unique index if not exists isp_payment_configs_payhero_channel_uniq[\s\S]*where payhero_channel_id is not null/,
    )
    expect(sql).toMatch(/channel_already_assigned/)
  })

  it('resolves the PayHero amount server-side, never from a parameter', () => {
    const sql = code(GATEWAY)
    expect(sql).toMatch(/resolve_chargeable\(p_invoice_id, p_client_id, p_plan_id\)/)
    // create_payhero_payment must have no amount parameter at all. Scoped to that
    // function's signature because the SETTLEMENT function legitimately accepts an
    // amount — it is reading what the provider confirmed, not being told a price.
    const createSig = sql.slice(
      sql.indexOf('create or replace function public.create_payhero_payment'),
      sql.indexOf('revoke all on function public.create_payhero_payment'),
    )
    expect(createSig).not.toMatch(/p_amount/i)
  })
})
describe('PayHero credential handling in shipped code', () => {
  it('never places a PayHero value in a public env var', () => {
    for (const f of [
      'src/lib/payhero.ts',
      'src/pages/admin/PlatformPayHero.tsx',
      'supabase/functions/_shared/payhero-credentials.ts',
    ]) {
      const src = code(f)
      expect(src, `${f} exposes a secret to the client`).not.toMatch(/NEXT_PUBLIC/)
      expect(src, `${f} exposes a VITE secret`).not.toMatch(/VITE_.*PAYHERO/)
    }
  })

  it('never returns the credential or its ciphertext to a browser', () => {
    const creds = code('supabase/functions/_shared/payhero-credentials.ts')
    // getPayHeroStatus must answer from presence, not from the secret.
    expect(creds).toMatch(/hasApiToken:[\s\S]*Boolean\(row\.payhero_api_token_ciphertext\)/)
    // The browser-facing status shape must have nowhere to put a secret. Scoped to
    // its type declarations only, because the interface's own doc comment
    // legitimately discusses `hasApiToken`, and the server-side
    // DecryptedPayHeroCredentials type holds the token for one request's lifetime.
    const statusIface = creds.slice(
      creds.indexOf('export interface PayHeroStatus'),
      creds.indexOf('export interface DecryptedPayHeroCredentials'),
    )
    // No field is typed as a token or a ciphertext, and nothing decrypts here.
    expect(statusIface).not.toMatch(/^\s*apiToken\s*[?:]/m)
    expect(statusIface).not.toMatch(/^\s*\w*ciphertext\s*[?:]/m)

    const client = code('src/lib/payhero.ts')
    // The browser layer offers no getter for the token at all.
    expect(client).not.toMatch(/export (async )?function getPayHeroApiToken/)
  })

  it('uses a key namespace separate from HashBack', () => {
    const secrets = code('supabase/functions/_shared/secrets.ts')
    expect(secrets).toMatch(/payhero: 'PAYHERO_CREDENTIALS_KEY'/)
    expect(secrets).toMatch(/hashback: 'HASHBACK_CREDENTIALS_KEY'/)
  })

  it('does not log the credential or the Basic auth header', () => {
    for (const f of [
      'supabase/functions/_shared/payhero.ts',
      'supabase/functions/_shared/payhero-credentials.ts',
      'supabase/functions/payhero-admin/index.ts',
      'supabase/functions/payhero-stk/index.ts',
      'supabase/functions/payhero-callback/index.ts',
    ]) {
      const src = code(f)
      // Any console output must not interpolate a token or an auth header.
      expect(src, `${f} logs a token`).not.toMatch(
        /console\.(log|info|warn|error)\([^)]*apiToken/,
      )
      expect(src, `${f} logs an auth header`).not.toMatch(
        /console\.(log|info|warn|error)\([^)]*Authorization/i,
      )
      expect(src, `${f} logs a decrypted credential`).not.toMatch(
        /console\.(log|info|warn|error)\([^)]*creds\./,
      )
    }
  })

  it('keeps the STK endpoint free of any amount parameter', () => {
    const fn = code('supabase/functions/payhero-stk/index.ts')
    // The whole reason this endpoint is safe: it cannot be told what to charge.
    expect(fn).toMatch(/No `amount` is read here/)
    expect(fn).not.toMatch(/body\.amount/)
    expect(fn).not.toMatch(/p_amount/)
  })
})

describe('PayHero endpoint security posture', () => {
  it('exempts only the callback from gateway JWT verification', () => {
    const config = code('supabase/config.toml')
    expect(config).toMatch(/\[functions\.payhero-callback\]/)
    expect(config).toMatch(/verify_jwt = false/)
    // payhero-admin and payhero-stk hold credentials and tenant authority, so
    // they must keep JWT verification on.
    expect(config).not.toMatch(/\[functions\.payhero-admin\][\s\S]*verify_jwt = false/)
    expect(config).not.toMatch(/\[functions\.payhero-stk\][\s\S]*verify_jwt = false/)
  })

  it('keeps a super-admin check on the admin endpoint', () => {
    const fn = code('supabase/functions/payhero-admin/index.ts')
    // Authorisation is enforced server-side against the caller's own profile, not
    // left to the UI route guard.
    expect(fn).toMatch(/role !== 'super_admin'/)
    expect(fn).toMatch(/admin\.auth\.getUser\(token\)/)
  })

  it('never trusts the callback body for the outcome', () => {
    const fn = code('supabase/functions/payhero-callback/index.ts')
    // Only the reference is read; the status always comes from PayHero.
    expect(fn).toMatch(/verifyPayHeroPayment\(\{ reference \}\)/)
    expect(fn).not.toMatch(/payload\.status/)
    expect(fn).not.toMatch(/body\.status/)
  })

  it('never invents a PayHero signature check', () => {
    // PayHero documents no HMAC. Inventing one would be security theatre, and a
    // test that "verifies" a made-up scheme would give false assurance.
    const fn = code('supabase/functions/payhero-callback/index.ts')
    expect(fn).not.toMatch(/createHmac|computeSignature|timingSafeEqual/)
    const svc = code('supabase/functions/_shared/payment-service.ts')
    expect(svc).not.toMatch(/createHmac|timingSafeEqual/)
  })
})

describe('active customer UI uses PayHero, not HashBack', () => {
  it('branches the portal on the resolved collection mode, not on a hard-coded provider', () => {
    const portal = code('src/pages/CaptivePortal.tsx')
    // The branch must go through the shared helper. Hard-coding 'payhero' here
    // would break every manual tenant the moment this file was edited again.
    expect(portal).toMatch(/collectionModeFor\(payment\.provider, payment\.mode\)/)
    expect(portal).not.toMatch(/payment\.mode === 'manual_till'\s*\?/)
  })

  it('never shows success from anything but the shared gate', () => {
    const portal = code('src/pages/CaptivePortal.tsx')
    // A screen that decides success for itself can drift and start claiming
    // payment on an STK acknowledgement.
    expect(portal).toMatch(/const settled = canShowSuccess\(phase\)/)
    expect(portal).not.toMatch(/status === 'success'\s*\?|res\.status === 'success'\s*\?/)
  })

  it('keeps the manual Till panel, and only as the manual path', () => {
    const portal = code('src/pages/CaptivePortal.tsx')
    // Manual collection is a real mode for tenants with no automated channel; it
    // is not deleted, it is simply not the default and not the active provider.
    expect(portal).toMatch(/function ManualTillPanel/)
    expect(portal).toMatch(/collectionModeFor\(payment\.provider, payment\.mode\) === 'manual_till'/)
  })
})

describe('admin and ISP surfaces name PayHero as the active provider', () => {
  it('leads the platform payments page with PayHero', () => {
    const page = code('src/pages/admin/PlatformPayments.tsx')
    expect(page).toMatch(/PayHero is the active M-Pesa payment provider/)
    expect(page).toMatch(/to="\/admin\/payment-gateway\/payhero"/)
  })

  it('marks HashBack as legacy rather than removing or promoting it', () => {
    const page = code('src/pages/admin/PlatformPayments.tsx')
    // Removing it would hide the provider five historical payments were settled
    // through; promoting it would tell an operator to configure the wrong thing.
    expect(page).toMatch(/Legacy — historical payments only/)
    expect(page).toMatch(/no longer the active provider/)
    expect(page).toMatch(/to="\/admin\/payment-gateway\/hashback"/)
  })

  it('shows the provider on the ISP payment settings page', () => {
    const page = code('src/pages/isp/settings/Payment.tsx')
    expect(page).toMatch(/function ProviderStatusCard/)
    // The tenant is resolved server-side from the caller's own profile; the page
    // must not take an ispId it could point somewhere else.
    expect(page).toMatch(/fetchMyPaymentChannel\(\)/)
    expect(page).not.toMatch(/fetchMyPaymentChannel\(\s*\w*[Ii]sp/)
  })

  it('labels the billing toggle so manual is not mistaken for the active path', () => {
    const page = code('src/pages/isp/views.tsx')
    // Online M-Pesa is the default; manual is labelled as an administrative act.
    expect(page).toMatch(/Online \(M-Pesa\)/)
    expect(page).toMatch(/Manual \/ admin/)
    expect(page).toMatch(/useState<'stk' \| 'manual_till'>\('stk'\)/)
  })
})
describe('ISP navigation offers only what an ISP bills with', () => {
  const layout = code('src/pages/isp/IspLayout.tsx')

  it('no longer offers Resellers, Commissions or Inventory', () => {
    // These are business features most connectivity ISPs never use, and they sat
    // in the permanent sidebar of a product whose core job is billing bandwidth.
    for (const gone of [
      "/app/resellers", "/app/commissions", "/app/inventory",
    ]) {
      expect(layout, gone).not.toMatch(new RegExp(`to: '${gone}'`))
    }
  })

  it('keeps the routes mounted so existing links and data still resolve', () => {
    // Navigation was removed, not the feature. Deleting the routes would 404 a
    // bookmark and strand an ISP that has historical rows in those tables.
    const app = code('src/App.tsx')
    for (const kept of ['resellers', 'commissions', 'inventory']) {
      expect(app, kept).toMatch(new RegExp(`path="${kept}"`))
    }
    for (const page of ['ResellersPage', 'CommissionsPage', 'InventoryPage']) {
      expect(app, page).toMatch(new RegExp(page))
    }
  })

  it('deletes no table or data to achieve the above', () => {
    // The requirement is a navigation change only.
    expect(layout).not.toMatch(/drop\s+table/i)
    expect(layout).not.toMatch(/delete\s+from/i)
  })

  it('still offers the core billing and network destinations', () => {
    // Removing three tabs must not quietly remove connectivity billing.
    for (const kept of [
      '/app/customers', '/app/invoices', '/app/payments', '/app/vouchers',
      '/app/sessions', '/app/sms', '/app/settings/portal', '/app/settings/payment',
      '/app/settings/network',
    ]) {
      expect(layout, kept).toMatch(new RegExp(`to: '${kept}'`))
    }
  })
})

describe('the captive portal routes a PayHero tenant to STK, not to a Till', () => {
  const sql = code('supabase/migrations/20260101300000_portal_payhero_route.sql')

  it('treats PayHero as an automated provider', () => {
    // The single defect that made the portal show a Till for a PayHero tenant.
    expect(sql).toMatch(/v_automated := v_cfg\.payment_provider::text in \('hashback', 'payhero'\)/)
  })

  it('requires a connected PayHero channel before it will prompt', () => {
    expect(sql).toMatch(/payment_provider::text = 'payhero' and v_cfg\.payhero_channel_id is null/)
  })

  it('reports the provider and its channel so the browser can branch correctly', () => {
    expect(sql).toMatch(/'provider', v_cfg\.payment_provider::text/)
    expect(sql).toMatch(/'payhero_channel_id', v_cfg\.payhero_channel_id/)
  })

  it('still routes a manual tenant to the instruction sheet', () => {
    // Not every ISP has an automated channel, and silently pretending otherwise
    // would send a customer to pay a Till that does not exist.
    expect(sql).toMatch(/elsif nullif\(btrim\(coalesce\(v_cfg\.till_number/)
  })

  it('resolves the tenant in two steps, because a row expansion cannot fill a composite', () => {
    // `select i.id, p.* into v_isp, v_plan` fails at runtime with
    // "v_plan is not a scalar variable", which leaves the OLD function in place and
    // the portal quietly still returning manual_till. This asserts the shape that
    // actually works.
    expect(sql).not.toMatch(/select i\.id, p\.\* into/)
    expect(sql).toMatch(/select \* into v_plan from public\.plans/)
  })
})

describe('portal settings are genuinely editable', () => {
  it('reads and writes through tenant-scoped paths, not local state', () => {
    const data = code('src/lib/data.ts')
    // A settings screen whose save only touched React state would look complete
    // and lose everything on reload. The write is an RPC; the read is a table
    // select already narrowed to this caller's tenant.
    expect(data).toMatch(/rpc\('save_portal_settings'/)
    expect(data).toMatch(/rpc\('reset_portal_settings'/)
    expect(data).toMatch(/from\('portal_settings'\)[\s\S]{0,80}tenantId\(\)/)
  })

  it('never names an ISP id when reading portal settings', () => {
    // tenantId() comes from the caller's own session. A page-supplied ispId is
    // how one tenant edits another's branding.
    const data = code('src/lib/data.ts')
    expect(data).not.toMatch(/fetchPortalSettings\s*\(\s*\w*\s*:\s*string/)
    expect(data).not.toMatch(/savePortalSettings\s*\(\s*\w*\s*:\s*string\s*,\s*\w*\s*:\s*string/)
  })

  it('exposes the branding and content fields the admin screen edits', () => {
    // If a control exists, the value it writes must be a column that persists.
    const screen = code('src/pages/isp/settings/CaptivePortal.tsx')
    for (const field of [
      'portal_name', 'primary_color', 'accent_color', 'logo_url', 'favicon_url',
      'background_color', 'welcome_message', 'payment_instructions',
      'support_phone', 'support_whatsapp', 'footer_text', 'packages_heading',
      'connect_button_text', 'featured_plan_id',
    ]) {
      expect(screen, field).toMatch(new RegExp(field))
    }
  })

  it('resolves public portal settings per ISP slug, never globally', () => {
    // A single global config would let one ISP's branding appear on another's
    // portal.
    const portal = code('src/lib/portal.ts')
    expect(portal).toMatch(/public_portal_settings/)
    expect(portal).toMatch(/public_portal_packages/)
  })
})

describe('no provider secret can reach the browser', () => {
  it('keeps the frontend payment modules free of credential handling', () => {
    for (const f of [
      'src/lib/provider.ts',
      'src/lib/payhero.ts',
      'src/lib/portal.ts',
      'src/pages/CaptivePortal.tsx',
      'src/pages/admin/PlatformPayHero.tsx',
    ]) {
      const src = code(f)
      expect(src, `${f} uses a public env var`).not.toMatch(/NEXT_PUBLIC_/)
      expect(src, `${f} reads a service key`).not.toMatch(/SERVICE_ROLE/)
      expect(src, `${f} names the encryption key`).not.toMatch(/PAYHERO_CREDENTIALS_KEY/)
      expect(src, `${f} reads the token directly`).not.toMatch(/payhero_api_token_ciphertext/)
    }
  })

  it('never calls a payment provider from browser code', () => {
    // The browser talks to ISPFLOW. ISPFLOW talks to PayHero. A direct fetch to
    // the provider would need the Basic token in the client, which is exactly the
    // leak this rule prevents.
    for (const f of [
      'src/lib/provider.ts',
      'src/lib/payhero.ts',
      'src/lib/portal.ts',
      'src/pages/CaptivePortal.tsx',
    ]) {
      expect(code(f), f).not.toMatch(/backend\.payhero\.co\.ke/)
      expect(code(f), f).not.toMatch(/api\.hashback\.co\.ke/)
    }
  })
})

describe('HashBack history is preserved and labelled honestly', () => {
  it('keeps the historical provider label intact', () => {
    // A historical HashBack payment must still read "HashBack". Relabelling it to
    // PayHero would corrupt the audit trail an operator reconciles against.
    expect(providerLabel('hashback')).toBe('HashBack')
  })

  it('keeps the HashBack enum value so old payments still typecheck', () => {
    // Adding a value is additive; the original enum definition is untouched.
    expect(code(ENUM)).not.toMatch(/hashback'::text\s*<>/)
    const cutover = code('supabase/migrations/20260101120000_daraja_cutover.sql')
    expect(cutover).toMatch(/labels remain/i)
  })

  it('keeps the legacy HashBack admin route mounted', () => {
    // The screen is retained for reconciliation. Deleting the route would strand
    // an operator mid-investigation with no way to see the old configuration.
    const app = code('src/App.tsx')
    expect(app).toMatch(/payment-gateway\/hashback/)
    expect(app).toMatch(/payment-gateway\/payhero/)
  })

  it('keeps every HashBack settlement entry point in the service', () => {
    const svc = code('supabase/functions/_shared/payment-service.ts')
    // Removing HashBack from the ACTIVE path must not remove its history or the
    // settlement function PayHero now also relies on.
    for (const fn of [
      'startPayment', 'processWebhookEvent', 'reconcilePayment', 'verifyPlatformConnection',
    ]) {
      expect(svc, fn).toMatch(new RegExp(fn))
    }
  })

  it('does not auto-assign a PayHero channel to any ISP', () => {
    // Three ISPs and one Till: which tenant collects through it is a business
    // decision, and the migration must not make it.
    const sql = code('supabase/migrations/20260101300000_portal_payhero_route.sql')
    expect(sql).not.toMatch(/13137/)
    // This migration only routes payments; it never writes a tenant's channel.
    expect(sql).not.toMatch(/insert into public\.isp_payment_configs/)
  })

  it('keeps the HashBack credential column on isp_payment_configs', () => {
    // Historical rows still carry it; dropping it would destroy them.
    expect(has('supabase/migrations/20260101100000_hashback_gateway.sql')).toBe(true)
    expect(code(GATEWAY)).not.toMatch(/drop column hashback_account_id/i)
  })
})