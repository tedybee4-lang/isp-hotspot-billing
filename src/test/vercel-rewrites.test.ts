/**
 * Regression tests for the production `/app/provision` failure:
 *
 *   "The provisioning API returned a non-JSON success response for
 *    /api/v1/routers/?search=mapito&size=50."
 *
 * Root cause: Vercel compiles rewrite `source` patterns with `strict: true`
 * (see `sourceToRegex` in @vercel/routing-utils), so `/api/:path*` matches
 * `/api/v1/routers` but NOT `/api/v1/routers/`. FastAPI's collection routes
 * are registered WITH the trailing slash, and `findRouter()` calls
 * `/api/v1/routers/?search=…&size=50` — that URL used to miss the proxy
 * rewrite, fall through to `/(.*)` → `/index.html`, and return the SPA as a
 * "successful" API response.
 *
 * These tests compile vercel.json with Vercel's own `convertRewrites` and
 * assert that every API shape the frontend actually requests resolves to the
 * VPS API *before* the SPA fallback, with the full path preserved.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertRewrites } from '@vercel/routing-utils'
import type { Rewrite } from '@vercel/routing-utils'

const HERE = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(
  readFileSync(resolve(HERE, '..', '..', 'vercel.json'), 'utf8'),
) as { rewrites?: Rewrite[] }

const API_HOST = 'https://ispbillingapi.codevertexafrica.com'

/** Routes compiled exactly the way Vercel's CDN compiles them. */
const routes = convertRewrites(config.rewrites ?? [])

/** First rewrite whose compiled regex matches `path`, or null. */
function firstMatch(path: string): { src?: string; dest?: string; status?: number } | null {
  for (const route of routes) {
    if ('src' in route && route.src && new RegExp(route.src).test(path)) {
      return route
    }
  }
  return null
}

describe('vercel.json API rewrites (production /app/provision regression)', () => {
  // The exact request that failed in production, plus the other shapes the
  // provisioning client uses.
  const apiPaths = [
    // The reported failure: FastAPI list route, trailing slash + query.
    ['/api/v1/routers/', '/api/v1/routers/?search=mapito&size=50'],
    // Same route without a query string.
    ['/api/v1/routers/', '/api/v1/routers/'],
    // POST target for upsertRouter (trailing slash).
    ['/api/v1/routers/', '/api/v1/routers/'],
    // Auth + non-collection routes (no trailing slash).
    ['/api/v1/auth/login', '/api/v1/auth/login'],
    ['/api/v1/provisioning/sessions', '/api/v1/provisioning/sessions?limit=20'],
    ['/api/v1/provisioning/device/scan', '/api/v1/provisioning/device/scan'],
    // Trailing-slash health probe.
    ['/health/', '/health/'],
    ['/health', '/health'],
  ] as const

  it.each(apiPaths)('proxies %s to the VPS API before the SPA fallback', (path, url) => {
    const match = firstMatch(path)
    expect(match, `no rewrite matched ${url}`).not.toBeNull()
    expect(match!.dest, `${url} fell through to the SPA fallback`).toMatch(
      new RegExp(`^${API_HOST}/`),
    )
  })

  it('preserves the complete API path (no dropped/duplicated segments)', () => {
    // The reported URL: capture group must rebuild /api/v1/routers/ exactly,
    // not /api/, /api/api/v1/routers/, or /api/v1/routers (slash stripped).
    const match = firstMatch('/api/v1/routers/')
    expect(match).not.toBeNull()
    const dest = match!.dest!
    expect(dest.startsWith(`${API_HOST}/api/`)).toBe(true)
    // Simulate Vercel's $1 substitution with the compiled source's capture.
    const capture = new RegExp(match!.src!).exec('/api/v1/routers/')?.[1]
    expect(['v1/routers', 'v1/routers/']).toContain(capture)
    const resolved = dest.replace(/\$1/g, capture ?? '')
    expect(resolved).toBe(`${API_HOST}/api/v1/routers/`)
  })

  it('keeps query strings on the original request (rewrites must not pin a query)', () => {
    // A destination with its own `?` would replace the caller's query.
    for (const route of routes) {
      if ('dest' in route && typeof route.dest === 'string' && route.dest.startsWith(API_HOST)) {
        expect(route.dest).not.toContain('?')
      }
    }
  })

  it('still serves the SPA for client routes', () => {
    expect(firstMatch('/app/provision')?.dest).toBe('/index.html')
    expect(firstMatch('/login')?.dest).toBe('/index.html')
  })

  it('does not shadow the API with the SPA fallback (ordering)', () => {
    // The catch-all must compile last among matching rewrites: the first match
    // wins, so every API path above must resolve to the VPS host.
    for (const [path] of apiPaths) {
      expect(firstMatch(path)?.dest).toMatch(new RegExp(`^${API_HOST.replace(/\//g, '\\/')}`))
    }
  })
})
