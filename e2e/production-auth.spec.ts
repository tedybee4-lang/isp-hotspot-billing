/**
 * Authenticated smoke test against a DEPLOYED build.
 *
 * Runs against E2E_BASE_URL, so the same assertions that guard a local build
 * also guard what is actually in production.
 *
 * The test-account password is NOT in this repository. It is supplied through
 * PLAYWRIGHT_TEST_PASSWORD, which is a local/CI environment variable and is
 * never committed, never bundled and never logged. If it is absent the suite
 * fails loudly rather than silently skipping, because a silently skipped
 * authenticated test is indistinguishable from a passing one.
 */
import { test, expect, type ConsoleMessage } from '@playwright/test'

const PASSWORD = process.env.PLAYWRIGHT_TEST_PASSWORD ?? ''
const ISP = process.env.PLAYWRIGHT_ISP_EMAIL ?? 'alpha@isp.test'
const ADMIN = process.env.PLAYWRIGHT_ADMIN_EMAIL ?? 'ops@ultrafaiba.net'

if (!PASSWORD) {
  throw new Error(
    'PLAYWRIGHT_TEST_PASSWORD is not set.\n'
    + 'These tests sign in as real accounts against a real deployment, so the '
    + 'password must be supplied through the environment, not committed.\n'
    + 'Example (PowerShell):\n'
    + "  $env:PLAYWRIGHT_TEST_PASSWORD = '<the shared test password>'\n"
    + '  $env:E2E_BASE_URL = 'https://your-deployment.example.com'',
  )
}

/** Console errors that actually break the page rather than noise. */
function fatalErrors(messages: ConsoleMessage[]): string[] {
  return messages
    .filter((m) => m.type() === 'error')
    .map((m) => m.text())
    .filter((t) => !/favicon|ERR_INTERNET_DISCONNECTED|Download the React DevTools/i.test(t))
}

async function signIn(page, email: string) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).first().click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 })
}

test.describe('deployed build, authenticated as an ISP owner', () => {
  test('walks the ISP pages without runtime errors', async ({ page }) => {
    const errors: string[] = []
    const failed: string[] = []
    page.on('console', (m) => errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()}`))

    await signIn(page, ISP)

    for (const path of ['/app', '/app/customers', '/app/sessions', '/app/packages',
      '/app/vouchers', '/app/routers', '/app/status', '/app/payments',
      '/app/settings', '/app/settings/payments']) {
      await page.goto(path)
      // NOT networkidle: Supabase realtime holds a connection open for the whole
      // session, so the network is never idle and the wait always times out.
      // Waiting for a rendered element is the real signal.
      await page.waitForLoadState('domcontentloaded')
      await page.waitForSelector('#root *', { timeout: 20000 })
      // The shell must render something; a blank screen is the failure mode.
      await expect(page.locator('#root')).not.toBeEmpty()
      expect(page.url(), `${path} redirected away`).toContain(path)
    }

    const fatal = fatalErrors(errors)
    expect(fatal, `console errors: ${fatal.join(' | ')}`).toEqual([])
    const realFailures = failed.filter((u) => !/favicon|beacon/i.test(u))
    expect(realFailures, `failed requests: ${realFailures.join(' | ')}`).toEqual([])
  })

  test('platform admin pages reject an ISP owner', async ({ page }) => {
    await signIn(page, ISP)
    await page.goto('/admin')
    await page.waitForTimeout(2500)
    // Either a redirect away from /admin, or an explicit refusal. What must not
    // happen is the admin shell rendering for a tenant user.
    const body = await page.locator('body').innerText()
    expect(body, 'an ISP owner reached the platform admin area')
      .not.toMatch(/Payment Gateway\s*·\s*HashBack/i)
  })
})

test('the live-sessions page renders its empty state honestly', async ({ page }) => {
  await signIn(page, ISP)
  await page.goto('/app/sessions')
  await page.waitForLoadState('domcontentloaded')
  // The auth gate renders "Checking your session..." before it resolves, so
  // reading the body during that window inspects a loader, not the page.
  await page.waitForSelector('text=Checking your session', {
    state: 'detached', timeout: 20000,
  })
  await page.waitForSelector('#root *', { timeout: 20000 })

  const body = await page.locator('body').innerText()
  // Production currently has no RADIUS sessions, so the page must say so rather
  // than inventing rows or rendering a spinner forever.
  expect(body).toMatch(/no .*(session|customer|online)/i)
  // And it must not claim there are customers online.
  expect(body).not.toMatch(/\b\d+\s+online\b/i)
  // No router credentials may ever reach the browser.
  expect(body).not.toMatch(/ROUTER_CREDENTIALS_KEY|service_role|sb_secret_/)
})

test.describe('deployed build, authenticated as the platform owner', () => {
  test('reaches the platform admin area and the HashBack screen', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await signIn(page, ADMIN)

    await page.goto('/admin')
    // NOT networkidle: Supabase realtime holds a connection open for the whole
      // session, so the network is never idle and the wait always times out.
      // Waiting for a rendered element is the real signal.
      await page.waitForLoadState('domcontentloaded')
      await page.waitForSelector('#root *', { timeout: 20000 })
    await expect(page.locator('#root')).not.toBeEmpty()

    await page.goto('/admin/payment-gateway/hashback')
    // NOT networkidle: Supabase realtime holds a connection open for the whole
      // session, so the network is never idle and the wait always times out.
      // Waiting for a rendered element is the real signal.
      await page.waitForLoadState('domcontentloaded')
      await page.waitForSelector('#root *', { timeout: 20000 })
    const body = await page.locator('body').innerText()

    // The screen must exist, and must never render a credential value.
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/sb_secret_[A-Za-z0-9]{10,}/)
    expect(body).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/)
    expect(errors, errors.join(' | ')).toEqual([])
  })
})