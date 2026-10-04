/**
 * End-to-end smoke test against the dev server.
 *
 * Verifies the two roles that matter, plus the public captive portal, by
 * driving a real browser. Assumes `npm run dev` is already serving.
 *
 *   npx playwright install chromium   # once
 *   npm run dev                       # in another terminal
 *   npm run test:e2e
 */
import { chromium, expect, test } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

test.describe.configure({ mode: 'serial' })

test('landing page renders the platform pitch', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: /Every ISP on one platform/i })).toBeVisible()
  await expect(page.getByText('Multi-tenant SaaS for ISPs')).toBeVisible()
  expect(errors).toEqual([])
})

test('unauthenticated users are redirected away from /admin', async ({ page }) => {
  await page.goto(`${BASE}/admin`)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('super admin can manage ISPs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${BASE}/login`)
  // The one-click demo button fills the super admin credentials.
  await page.getByRole('button', { name: /super admin/i }).click()
  await page.getByRole('button', { name: /^sign in$/i }).click()

  await expect(page).toHaveURL(/\/admin$/, { timeout: 15000 })
  await expect(page.getByRole('heading', { name: 'Platform Overview' })).toBeVisible()

  // Platform KPIs are populated from seeded tenants
  await expect(page.getByText('ISPs on platform')).toBeVisible()
  await expect(page.getByText('Active subscribers')).toBeVisible()
  await expect(page.getByText('Revenue (30d)')).toBeVisible()
  await expect(page.getByText('Outstanding')).toBeVisible()

  // Tenant table lists the seeded ISPs
  await expect(page.getByText('Ultrafaiba Networks').first()).toBeVisible()
  await expect(page.getByText('Rift Valley Broadband').first()).toBeVisible()

  // Navigate to the ISP manager and open a tenant
  await page.getByRole('link', { name: /manage isps/i }).click()
  await expect(page).toHaveURL(/\/admin\/isps$/)
  await page.getByText('Ultrafaiba Networks').first().click()
  await expect(page).toHaveURL(/\/admin\/isps\/[^/]+$/)
  await expect(page.getByRole('heading', { name: 'Ultrafaiba Networks' })).toBeVisible()
  await expect(page.getByText('Plan limits')).toBeVisible()

  // Status controls are present on the tenant detail screen
  await expect(page.getByRole('button', { name: /suspend|reactivate/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /limits/i })).toBeVisible()

  // Payment collection — the super admin picks how this tenant takes money
  await expect(page.getByText('Payment collection')).toBeVisible()

  // All three modes are offered, and the default (Manual Till) needs no keys
  await expect(page.getByRole('button', { name: /Manual Till \/ Paybill/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Platform Daraja/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Own Daraja account/ })).toBeVisible()

  // Default mode exposes Till/Paybill fields and NO Daraja secret fields
  await expect(page.getByLabel(/till number/i)).toBeVisible()
  await expect(page.getByLabel(/paybill number/i)).toBeVisible()
  await expect(page.getByLabel(/consumer secret/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /save payment settings/i })).toBeVisible()

  // Switching to Platform Daraja shows the shortcode but still no secret fields
  await page.getByRole('button', { name: /Platform Daraja/ }).click()
  await expect(page.getByLabel(/paybill shortcode/i)).toBeVisible()
  await expect(page.getByLabel(/consumer secret/i)).toHaveCount(0)

  // Own Daraja is the only mode that asks for keys
  await page.getByRole('button', { name: /Own Daraja account/ }).click()
  await expect(page.getByLabel(/daraja consumer secret/i)).toBeVisible()

  // Production mode must warn before charging real money
  await expect(page.getByText(/charge real money/i)).toHaveCount(0)
  await page.getByRole('button', { name: 'production' }).click()
  await expect(page.getByText(/charge real money/i)).toBeVisible()
  await page.getByRole('button', { name: 'sandbox' }).click()

  // Secrets must never be echoed back into the DOM
  const html = await page.content()
  expect(html).not.toMatch(/consumer_secret['"\s:=]+[A-Za-z0-9]{20,}/i)

  // Audit log
  await page.getByRole('link', { name: /audit log/i }).click()
  await expect(page).toHaveURL(/\/admin\/audit$/)
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()

  expect(errors).toEqual([])
})

test('ISP owner sees their own tenant, not the admin panel', async ({ page }) => {
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: /isp owner/i }).click()
  await page.getByRole('button', { name: /^sign in$/i }).click()

  await expect(page).toHaveURL(/\/app\/panel$/, { timeout: 15000 })
  await expect(page.getByRole('heading', { name: /Ultrafaiba Networks/ }).first()).toBeVisible()

  // The ISP nav must not expose platform administration
  await expect(page.getByRole('link', { name: /^ISPs$/ })).toHaveCount(0)

  // Visiting /admin directly bounces back to the tenant workspace
  await page.goto(`${BASE}/admin`)
  await expect(page).toHaveURL(/\/app\//)
})

test('public captive portal is reachable without signing in', async ({ page }) => {
  await page.goto(`${BASE}/portal/alpha-nets`)

  // Branded for this tenant, and showing the catalogue rather than only a
  // voucher box: packages are the reason the page exists.
  await expect(page.getByRole('heading', { name: /Alpha Nets/ })).toBeVisible()
  await expect(page.getByText('Hourly Hotspot').first()).toBeVisible()

  // The "Already Paid" control is a real link into the login section, not
  // decoration: it is the first thing a just-paid customer reaches for.
  await expect(page.getByRole('link', { name: /already paid/i })).toHaveAttribute(
    'href',
    '#login-heading',
  )

  // The secondary ways in are still offered underneath the packages.
  await expect(page.getByRole('heading', { name: /voucher/i })).toBeVisible()
})

test('the portal collapses to one column on the narrowest phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(`${BASE}/portal/alpha-nets`)

  const card = page.locator('section[aria-labelledby="packages-heading"] >> div').first()
  const columns = await card.evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
  )
  // Two cards at 320px leaves each one too narrow to read a price.
  expect(columns).toBe(1)
})

test('an invalid voucher code is rejected gracefully', async ({ page }) => {
  await page.goto(`${BASE}/portal/alpha-nets`)

  await page.getByPlaceholder('XXXX-0000').fill('BOGUS-1234')
  await page.getByRole('button', { name: /activate voucher/i }).click()
  // Deliberately worded per-network rather than the old platform-wide wording:
  // the redemption is now scoped to the tenant the slug resolved to, so a code
  // from another ISP is correctly reported as invalid here rather than found.
  await expect(page.getByText(/not valid on this network/i)).toBeVisible()
})

test('buying a package never lets the browser choose the amount or the tenant', async ({
  page,
}) => {
  // Drive a real purchase as far as it will go, and inspect what was actually
  // sent. Asserting on the request body is the point: the browser must not be
  // able to influence where its money goes, only which package it wants.
  const sent: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/functions/v1/portal-stk')) sent.push(req.postData() ?? '')
  })

  await page.goto(`${BASE}/portal/alpha-nets`)
  // The card's own call to action, labelled from the tenant's settings.
  await page.getByRole('button', { name: /click here to connect/i }).first().click()
  // Scoped to the dialog: the voucher section below uses the same placeholder.
  await page
    .getByRole('dialog')
    .getByPlaceholder('07XXXXXXXX')
    .fill('0712345678')
  await page.getByRole('button', { name: 'Pay with M-Pesa' }).click()

  // Wait for either the payment to be refused or the poll to start.
  await page.waitForTimeout(6000)

  expect(sent.length).toBeGreaterThan(0)
  for (const body of sent) {
    // Only a slug, a plan and a phone. Nothing that decides the destination.
    expect(body).not.toMatch(/"amount"\s*:/i)
    expect(body).not.toMatch(/"ispId"|"isp_id"/i)
    expect(body).not.toMatch(/"accountId"|"account_id"/i)
    expect(body).toMatch(/"slug"/)
  }
})

test('unknown portal slug shows a friendly 404', async ({ page }) => {
  await page.goto(`${BASE}/portal/does-not-exist`)
  await expect(page.getByRole('heading', { name: /portal not found/i })).toBeVisible()
})

test('an unknown route renders the 404 page', async ({ page }) => {
  await page.goto(`${BASE}/totally/made/up`)
  await expect(page.getByText('404')).toBeVisible()
})