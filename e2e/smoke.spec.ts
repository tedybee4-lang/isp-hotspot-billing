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
  await page.goto(`${BASE}/portal/ultrafaiba`)
  await expect(page.getByRole('heading', { name: /Ultrafaiba Networks/ })).toBeVisible()
  await expect(page.getByText('Enter your voucher code to get online')).toBeVisible()

  // An invalid code is rejected gracefully
  await page.getByPlaceholder('XXXX-0000').fill('BOGUS-1234')
  await page.getByRole('button', { name: /connect/i }).click()
  await expect(page.getByText(/not found on this platform/i)).toBeVisible()
})

test('unknown portal slug shows a friendly 404', async ({ page }) => {
  await page.goto(`${BASE}/portal/does-not-exist`)
  await expect(page.getByRole('heading', { name: /portal not found/i })).toBeVisible()
})

test('an unknown route renders the 404 page', async ({ page }) => {
  await page.goto(`${BASE}/totally/made/up`)
  await expect(page.getByText('404')).toBeVisible()
})