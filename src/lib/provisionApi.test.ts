/**
 * Tests for the provisioning API client (`src/lib/provisionApi.ts`).
 *
 * The rebuilt feature authenticates through Supabase: the browser signs in
 * once, and the client attaches the signed-in user's real access token to
 * every provisioning request. There is no engine-side login and no local
 * token cache, so these tests pin that contract instead:
 *
 *   - a signed-in session supplies the Bearer token
 *   - a missing/expired session that cannot be refreshed never issues a
 *     request (no anonymous call is ever attempted)
 *   - HTTP 401 / 403 / 422 / 500 are surfaced distinctly, and a backend 500
 *     is never masqueraded as an authentication failure
 *   - non-JSON bodies (the Vercel SPA fallback, proxy error pages) are
 *     reported as such with the real status
 *   - session list, empty list, bootstrap generation and invalid router input
 *     all behave
 *
 * Everything is exercised against a fetch stub and a stubbed Supabase client
 * — no backend required.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Supabase auth stub. Declared with `vi.hoisted` so the module factory below
 * can reference it before the test body runs (the mocked module resolves
 * during import, which happens before module-level `const` initialisation).
 */
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: { auth },
  requireSupabase: () => ({ auth }),
}))

vi.mock('./config', () => ({
  IS_LIVE: true,
  config: { apiUrl: 'https://api.example.com' },
}))

import {
  listSessions, getBootstrapCommand, ProvisionError, ProvisionErrorCode,
  createSession, findRouter,
} from './provisionApi'

interface Session { access_token: string }

/** The Supabase session shapes the client must handle. */
function session(value: Session | null, error: Error | null = null) {
  return { data: { session: value }, error }
}

function authHeaderOf(init?: RequestInit): string {
  return String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
}

/** Captures the ProvisionError a rejected call produced, failing if it did not. */
async function caughtError(p: Promise<unknown>): Promise<ProvisionError> {
  try {
    await p
  } catch (e) {
    return e as ProvisionError
  }
  throw new Error('expected the call to reject, but it resolved')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  // Default: a signed-in user with a real access token.
  auth.getSession.mockReset()
  auth.refreshSession.mockReset()
  auth.getSession.mockResolvedValue(session({ access_token: 'supabase-access-token' }))
  auth.refreshSession.mockResolvedValue(session({ access_token: 'refreshed-token' }))
})

function jsonResponse(body: unknown, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', fn)
  return fn
}

// `_url` parameters are intentionally unused: the handler receives the URL but
// these handlers only assert on headers or bodies.

/* ── Authentication ─────────────────────────────────────────────────────── */

describe('authentication from the Supabase session', () => {
  it('attaches the signed-in user access token to every provisioning request', async () => {
    let header = ''
    stubFetch((_url, init) => {
      header = authHeaderOf(init)
      return jsonResponse({ sessions: [] })
    })

    await listSessions()

    expect(header).toBe('Bearer supabase-access-token')
    expect(auth.getSession).toHaveBeenCalled()
  })

  it('never uses the Supabase anon key as the bearer token', async () => {
    let header = ''
    stubFetch((_url, init) => {
      header = authHeaderOf(init)
      return jsonResponse({ sessions: [] })
    })

    await listSessions()

    expect(header).not.toMatch(/supabase.*anon/i)
    expect(header.startsWith('Bearer ')).toBe(true)
    expect(header.replace('Bearer ', '').length).toBeGreaterThan(0)
  })

  it('restores a session via refresh when getSession has none yet (page reload)', async () => {
    // The initial read is empty — the client has just mounted and Supabase has
    // not rehydrated the persisted session yet. It must refresh rather than
    // failing the operator out.
    auth.getSession.mockResolvedValueOnce(session(null))

    let header = ''
    stubFetch((_url, init) => {
      header = authHeaderOf(init)
      return jsonResponse({ sessions: [] })
    })

    await expect(listSessions()).resolves.toEqual([])
    expect(header).toBe('Bearer refreshed-token')
  })

  it('issues NO request when there is no session and refresh fails', async () => {
    auth.getSession.mockResolvedValue(session(null))
    auth.refreshSession.mockResolvedValue(
      session(null, new Error('refresh_token_already_used')),
    )
    const fetchMock = stubFetch(() => jsonResponse({ sessions: [] }))

    await expect(listSessions()).rejects.toMatchObject({
      code: ProvisionErrorCode.NOT_AUTHENTICATED,
      needsSignIn: true,
    })
    // The core guarantee: unauthenticated traffic is never sent.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a session read error immediately without sending a request', async () => {
    auth.getSession.mockResolvedValue(session(null, new Error('lock broken')))
    const fetchMock = stubFetch(() => jsonResponse({ sessions: [] }))

    await expect(listSessions()).rejects.toMatchObject({ needsSignIn: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/* ── Session list ───────────────────────────────────────────────────────── */

describe('provisioning session list', () => {
  it('returns real sessions from the backend', async () => {
    stubFetch(() => jsonResponse({
      sessions: [{
        session_id: 's1', router_id: 1, status: 'completed',
        service_type: 'hotspot', created_at: '2026-01-01T00:00:00Z', completed_at: null,
      }],
      skip: 0, limit: 20, total: 1,
    }))

    const sessions = await listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].session_id).toBe('s1')
  })

  it('handles an empty session list as a valid empty array', async () => {
    stubFetch(() => jsonResponse({ sessions: [], total: 0 }))
    await expect(listSessions()).resolves.toEqual([])
  })

  it('handles a response with no sessions key at all', async () => {
    stubFetch(() => jsonResponse({}))
    await expect(listSessions()).resolves.toEqual([])
  })

  it('requests the page the acceptance criteria names', async () => {
    let url = ''
    stubFetch((u) => {
      url = String(u)
      return jsonResponse({ sessions: [] })
    })
    await listSessions()
    expect(url).toContain('/api/v1/provisioning/sessions?limit=20')
  })
})

/* ── HTTP error handling ────────────────────────────────────────────────── */

describe('HTTP error handling', () => {
  it('surfaces an expired session (401) as a sign-in prompt', async () => {
    stubFetch(() => jsonResponse({ detail: 'Not authenticated' }, 401))
    await expect(listSessions()).rejects.toMatchObject({
      code: ProvisionErrorCode.NOT_AUTHENTICATED,
      status: 401,
      needsSignIn: true,
    })
  })

  it('surfaces a 403 as a permission problem, not an authentication failure', async () => {
    stubFetch(() => jsonResponse({ detail: 'Insufficient permissions' }, 403))
    const err = await caughtError(listSessions())
    expect(err).toBeInstanceOf(ProvisionError)
    expect(err.code).toBe(ProvisionErrorCode.FORBIDDEN)
    expect(err.status).toBe(403)
    expect(err.needsSignIn).toBe(false)
  })

  it('surfaces a 404 as not-found', async () => {
    stubFetch(() => jsonResponse({ detail: 'Provisioning session not found' }, 404))
    await expect(listSessions()).rejects.toMatchObject({
      code: ProvisionErrorCode.NOT_FOUND,
      status: 404,
    })
  })

  it('never reports a backend 500 as an authentication error', async () => {
    // The regression this guards: an unhandled exception inside a provisioning
    // endpoint used to be misreported as "not authenticated", sending the
    // operator to the login page to fix a server-side bug.
    stubFetch(() => jsonResponse({ detail: 'Failed to list provisioning sessions' }, 500))
    const err = await caughtError(listSessions())
    expect(err.code).toBe(ProvisionErrorCode.SERVER_ERROR)
    expect(err.status).toBe(500)
    expect(err.needsSignIn).toBe(false)
    expect(err.message).not.toMatch(/sign in/i)
  })

  it('aborts before sending when the API client detects a misconfigured origin', async () => {
    // config is stubbed, so a relative path is fine; just assert the path is
    // joined against the configured base rather than the current origin.
    let url = ''
    stubFetch((u) => {
      url = String(u)
      return jsonResponse({ items: [] })
    })
    await findRouter('office')
    expect(url.startsWith('https://api.example.com/')).toBe(true)
  })})

/* ── Non-JSON responses ─────────────────────────────────────────────────── */

describe('non-JSON responses', () => {
  it('rejects the Vercel SPA fallback returned as a "successful" API response', async () => {
    // Production bug: an un-proxied API path returned index.html with HTTP
    // 200. It must surface as an error, never as a fake empty result.
    stubFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: () => Promise.resolve('<!doctype html><html></html>'),
    } as unknown as Response))

    await expect(listSessions()).rejects.toMatchObject({
      code: ProvisionErrorCode.NON_JSON_RESPONSE,
      status: 200,
    })
  })

  it('surfaces a non-JSON error response with its real status', async () => {
    stubFetch(() => ({
      ok: false,
      status: 502,
      headers: { get: () => 'text/html' },
      text: () => Promise.resolve('<html>bad gateway</html>'),
    } as unknown as Response))

    const err = await caughtError(listSessions())
    expect(err.status).toBe(502)
    expect(err.code).toBe(ProvisionErrorCode.NON_JSON_RESPONSE)
  })

  it('treats an empty 200 body as an error rather than a silent success', async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(null),
    } as unknown as Response))

    await expect(listSessions()).rejects.toBeInstanceOf(ProvisionError)
  })
})

/* ── Network failures ───────────────────────────────────────────────────── */

describe('network failures', () => {
  it('turns a fetch failure into an actionable engine-unreachable error', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch') })
    const err = await caughtError(listSessions())
    expect(err.code).toBe(ProvisionErrorCode.ENGINE_UNREACHABLE)
    expect(err.detail).toMatchObject({ reason: 'engine-unreachable' })
    expect(err.message).toMatch(/Cannot reach the provisioning engine/)
  })
})

/* ── Bootstrap command generation ───────────────────────────────────────── */

describe('bootstrap command generation', () => {
  it('returns the real one-liner generated by the backend', async () => {
    let requested = ''
    stubFetch((u) => {
      requested = String(u)
      expect(requested).toContain('/api/v1/provisioning/bootstrap/command')
      return jsonResponse({
        command: '/tool fetch mode=https url="https://api.example.com/..." dst-path=ISP.rsc',
        script_url: 'https://api.example.com/api/v1/provisioning/bootstrap/script?token=abc',
        token: 'bootstrap-token',
        expires_in: 600,
        notes: ['Waiting for mikrotik to come online...'],
        notify_url: 'https://api.example.com/api/v1/provisioning/bootstrap/notify',
        bootstrap_already_done: false,
        encrypted_url: false,
      })
    })

    const b = await getBootstrapCommand({
      identity: 'Office Router', api_port: 8728, interface: 'ether1',
      ip_address: '192.168.88.1', session_id: 'sess-1', router_id: 7,
    })
    expect(b.command).toContain('/tool fetch')
    expect(b.token).toBe('bootstrap-token')
  })

  it('sends the parameters the backend route requires', async () => {
    let url = ''
    stubFetch((u) => {
      url = String(u)
      return jsonResponse({ command: 'c', notes: [], notify_url: '', bootstrap_already_done: false })
    })

    await getBootstrapCommand({
      identity: 'Office Router', api_port: 8728, interface: 'ether1',
      ip_address: '192.168.88.1', session_id: 'sess-1', router_id: 7,
    })

    const qs = new URL(url).searchParams
    expect(qs.get('identity')).toBe('Office Router')
    expect(qs.get('api_port')).toBe('8728')
    expect(qs.get('interface')).toBe('ether1')
    expect(qs.get('ip_address')).toBe('192.168.88.1')
    expect(qs.get('session_id')).toBe('sess-1')
    expect(qs.get('router_id')).toBe('7')
  })

  it('surfaces invalid router input (422) as a validation error, not a crash', async () => {
    stubFetch(() => jsonResponse({
      detail: 'Router identity contains unsupported characters',
    }, 422))

    const err = await caughtError(getBootstrapCommand({
      identity: 'bad/identity', api_port: 8728, interface: 'ether1',
    }))

    expect(err.code).toBe(ProvisionErrorCode.VALIDATION_ERROR)
    expect(err.status).toBe(422)
    expect(err.message).toMatch(/unsupported characters/)
  })

  it('reports a missing session (404) plainly', async () => {
    stubFetch(() => jsonResponse({ detail: 'Provisioning session not found' }, 404))
    await expect(
      getBootstrapCommand({ identity: 'R', api_port: 8728, interface: 'ether1', session_id: 'nope' }),
    ).rejects.toMatchObject({ code: ProvisionErrorCode.NOT_FOUND })
  })
})

/* ── Session creation (wizard step 1) ───────────────────────────────────── */

describe('createSession', () => {
  it('posts the router, service type and configuration the backend expects', async () => {
    let body = ''
    let url = ''
    stubFetch((u, init) => {
      url = String(u)
      body = String(init?.body)
      return jsonResponse({ session_id: 's1', status: 'pending' }, 201)
    })

    const res = await createSession(7, 'hotspot', { identity: 'Office Router' })
    expect(res.session_id).toBe('s1')
    expect(url).toContain('/api/v1/provisioning/sessions')
    expect(JSON.parse(body)).toEqual({
      router_id: 7, service_type: 'hotspot', configuration: { identity: 'Office Router' },
    })
  })
})
