// =============================================================================
//  REST client.
//
//  REST is worth keeping for three reasons, and only three:
//
//    * it is the only transport a browser can speak, so the panel's one-off
//      actions still work without the worker;
//    * it is stateless and cheap, which matters on a low-power device;
//    * on RouterOS 7.1+ over HTTPS it is perfectly safe.
//
//  It is never the only option, because REST does not exist before 7.1 - which is
//  the hAP lite, the RB951 and a large part of the installed base.
//
//  Plain HTTP is refused here on purpose. The router password is the only thing
//  protecting the device's management plane, and sending it in cleartext to save
//  a TLS handshake is not a trade anyone should make by default.
// =============================================================================

import type { ConnectionMethod } from './session.ts'

export interface RestTarget {
  host: string
  restPort: number
  restScheme: 'http' | 'https'
  username: string
  password: string
}

export interface RestResult {
  rows: Record<string, string>[]
  method: Extract<ConnectionMethod, 'rest'>
  latencyMs: number
}

const basicAuth = (user: string, pass: string): string =>
  'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')

/** Thrown when REST is asked for over plain HTTP. */
export class InsecureTransportError extends Error {
  constructor(host: string) {
    super(
      `Refusing to send router credentials to ${host} over plain HTTP. `
      + 'Enable the api-ssl service on the router, or reach it over a VPN, so the '
      + 'management password is never transmitted in clear.',
    )
    this.name = 'InsecureTransportError'
  }
}

/**
 * One REST command.
 *
 * REST returns `key=value` lines. A value may itself contain `=`, so the split
 * is on the first one only - splitting on every `=` truncates passwords and
 * comments that contain one.
 */
export async function restCommand(
  target: RestTarget,
  command: string,
  params: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<Record<string, string>[]> {
  if (target.restScheme !== 'https') throw new InsecureTransportError(target.host)

  const url = `https://${target.host}:${target.restPort}/rest/${command}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(target.username, target.password),
        'Content-Type': 'text/plain',
      },
      body: Object.entries(params).map(([k, v]) => `${k}=${v}`).join('\n'),
      signal: ac.signal,
    })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    throw new Error(aborted
      ? `${command} timed out after ${timeoutMs}ms`
      : `Cannot reach ${target.host} over REST: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new Error(restError(command, res.status))

  const text = (await res.text()).trim()
  if (!text) return []

  return text.split('\n').filter(Boolean).map((line) => {
    const row: Record<string, string> = {}
    for (const pair of line.split('=')) {
      const eq = pair.indexOf('=')
      if (eq > 0) row[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    return row
  })
}

/**
 * Turns an HTTP status into something an ISP can act on.
 *
 * A 404 in particular is not a fault: it is what a RouterOS 6 router says, and
 * it must be reported as "REST unavailable", not as "the router is broken".
 */
function restError(command: string, status: number): string {
  if (status === 401 || status === 403) {
    return `${command} was rejected (HTTP ${status}): the username or password is wrong.`
  }
  if (status === 404) {
    return `${command} returned 404: the REST service is disabled on this router. `
      + 'REST exists only on RouterOS 7.1 and later; the API is used instead.'
  }
  return `${command} failed: HTTP ${status}`
}

/** Exposed so the client can report which transport actually ran. */
export function restMethod(): Extract<ConnectionMethod, 'rest'> {
  return 'rest'
}