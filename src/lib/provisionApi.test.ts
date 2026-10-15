/**
 * Tests for the new unauthenticated provisioning API client (`src/lib/provisionApi.ts`).
 *
 * The new feature is 100% public, unauthenticated, and self-contained:
 * - No Supabase imports, no Authorization headers, no 401 error checks
 * - Pure fetch() calls to /api/v1/provisioning/*
 */
import { describe, expect, it, vi } from 'vitest'

import { generateBootstrapCommand, fetchProvisioningSessions } from './provisionApi'

vi.mock('./config', () => ({
  IS_LIVE: true,
  config: { apiUrl: 'https://api.example.com' },
}))

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

describe('generateBootstrapCommand', () => {
  it('returns the bootstrap command from the backend', async () => {
    let requestedUrl = ''
    let requestedBody = ''
    stubFetch((u, init) => {
      requestedUrl = String(u)
      requestedBody = String(init?.body)
      return jsonResponse({
        session_id: 'sess-123',
        bootstrap_command: '/tool fetch mode=https url="https://api.example.com/..." dst-path=ISP.rsc;:delay 2s;/import ISP.rsc;',
      })
    })

    const result = await generateBootstrapCommand({
      identity: 'Office Router',
      wan_interface: 'ether1',
    })

    expect(result.session_id).toBe('sess-123')
    expect(result.bootstrap_command).toContain('/tool fetch')
    expect(requestedUrl).toBe('/api/v1/provisioning/bootstrap')
    expect(JSON.parse(requestedBody)).toEqual({
      identity: 'Office Router',
      wan_interface: 'ether1',
    })
  })

  it('uses default values when identity or wan_interface are empty', async () => {
    let requestedBody = ''
    stubFetch((_u, init) => {
      requestedBody = String(init?.body)
      return jsonResponse({
        session_id: 'sess-123',
        bootstrap_command: 'command',
      })
    })

    await generateBootstrapCommand({
      identity: '',
      wan_interface: '',
    })

    expect(JSON.parse(requestedBody)).toEqual({
      identity: 'Router-1',
      wan_interface: 'ether1',
    })
  })

  it('throws on non-ok response', async () => {
    stubFetch(() => jsonResponse({ detail: 'Server error' }, 500))

    await expect(generateBootstrapCommand({
      identity: 'Test Router',
      wan_interface: 'ether1',
    })).rejects.toThrow('Server error')
  })

  it('throws on network error', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch') })

    await expect(generateBootstrapCommand({
      identity: 'Test Router',
      wan_interface: 'ether1',
    })).rejects.toThrow('Failed to fetch')
  })
})

describe('fetchProvisioningSessions', () => {
  it('returns sessions from the backend', async () => {
    let requestedUrl = ''
    stubFetch((u) => {
      requestedUrl = String(u)
      return jsonResponse([
        { id: 'sess-1', identity: 'Router 1', wan_interface: 'ether1', status: 'completed' },
        { id: 'sess-2', identity: 'Router 2', wan_interface: 'ether2', status: 'pending' },
      ])
    })

    const sessions = await fetchProvisioningSessions()

    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe('sess-1')
    expect(sessions[0].identity).toBe('Router 1')
    expect(requestedUrl).toBe('/api/v1/provisioning/sessions')
  })

  it('returns empty array on non-ok response', async () => {
    stubFetch(() => jsonResponse({ detail: 'Server error' }, 500))

    const sessions = await fetchProvisioningSessions()
    expect(sessions).toEqual([])
  })

  it('returns empty array on network error', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch') })

    const sessions = await fetchProvisioningSessions()
    expect(sessions).toEqual([])
  })
})