// =============================================================================
//  Transport-agnostic RouterOS session core.
//
//  This module is deliberately free of any runtime API - no fetch, no WebSocket,
//  no node:net. It only knows how to speak sentences.
//
//  That is what lets the Edge Function (WebSocket) and the VPS worker (raw TCP
//  and TLS) share one implementation of the hard part: matching `!done` and
//  `!fail` sentences to the command that is waiting for them. Two copies of
//  that logic would drift, and the drift would show up as commands silently
//  returning the wrong rows.
//
//  The wire protocol itself lives in rosapi.ts, which the Edge Function also
//  imports, so encoding and decoding cannot diverge between the two runtimes.
// =============================================================================

import { encodeSentence, SentenceDecoder, type Sentence } from './rosapi.ts'

export type ConnectionMethod = 'rest' | 'api' | 'api_ssl' | 'ssh' | 'unavailable'

/** The byte channel a session runs over. Implemented per runtime. */
export interface WireChannel {
  send(bytes: Uint8Array): void
  close(): void
}

export class RouterConnectError extends Error {
  constructor(
    message: string,
    readonly method: ConnectionMethod | null = null,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'RouterConnectError'
  }
}

export const DEFAULT_TIMEOUT = 8000

interface Waiter {
  resolve: (rows: Record<string, string>[]) => void
  reject: (err: Error) => void
  rows: Record<string, string>[]
  failed: Sentence | null
  timer: ReturnType<typeof setTimeout>
  command: string
}

export interface ApiOptions {
  timeoutMs?: number
  /** Sent as the first command word; only honoured from RouterOS 6.43. */
  tag?: string
}

/**
 * One API session.
 *
 * Commands are strictly serialised. RouterOS answers sentences in order, and
 * interleaving two commands on one socket makes it impossible to tell which
 * `!done` belongs to which request - so a queue is the correct shape here, not
 * an optimisation. Throughput comes from keeping the socket open between polls,
 * not from issuing commands in parallel on one socket.
 */
export class RouterOsApi {
  private readonly decoder = new SentenceDecoder()
  private waiters: Waiter[] = []
  private closedError: Error | null = null

  constructor(
    private readonly channel: WireChannel,
    private readonly opts: ApiOptions = {},
  ) {}

  /** Builds a session from an already-open channel and logs in. */
  static async open(
    channel: WireChannel,
    username: string,
    password: string,
    opts: ApiOptions = {},
  ): Promise<RouterOsApi> {
    const api = new RouterOsApi(channel, opts)
    await api.execute('/login', { name: username, password })
    return api
  }
// Runs one command and returns its rows. Throws on `!fail`.
  async execute(
    command: string,
    params: Record<string, string | undefined> = {},
  ): Promise<Record<string, string>[]> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT
    // A value may be undefined: those keys are dropped rather than emitted as
    // empty words, which RouterOS reads as "clear this property" on `set`.
    const words: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      words[key] = String(value)
    }
    if (this.opts.tag) words['!tag'] = this.opts.tag

    return new Promise<Record<string, string>[]>((resolve, reject) => {
      if (this.closedError) { reject(this.closedError); return }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer)
        reject(new RouterConnectError(
          `${command} did not answer within ${timeoutMs}ms`, null, undefined, true))
      }, timeoutMs)

      this.waiters.push({ resolve, reject, rows: [], failed: null, timer, command })
      try {
        this.channel.send(encodeSentence(command, words))
      } catch (err) {
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w.timer !== timer)
        reject(new RouterConnectError(`Could not send ${command}: ${String(err)}`))
      }
    })
  }

  /** Called by the channel owner for every chunk, or with null on close. */
  ingest(chunk: Uint8Array | null): void {
    if (chunk === null) {
      this.failAll(new RouterConnectError('The router closed the API connection.'))
      return
    }
    let sentences: Sentence[] = []
    try {
      sentences = this.decoder.push(chunk)
    } catch (err) {
      this.failAll(new RouterConnectError(`Malformed API data: ${String(err)}`))
      return
    }
    for (const sentence of sentences) this.dispatch(sentence)
  }

  private dispatch(sentence: Sentence): void {
    // A trap is not tied to a command; the router logs it and the connection
    // stays usable, so it must not fail an unrelated waiter.
    if (sentence.kind === 'trap') return

    const waiter = this.waiters[0]
    if (!waiter) return   // unsolicited row; nothing is waiting for it

    if (sentence.kind === 'row') { waiter.rows.push(sentence.row); return }
    if (sentence.kind === 'fail') waiter.failed = sentence

    clearTimeout(waiter.timer)
    this.waiters.shift()
    if (waiter.failed) {
      // A `!fail` is the router answering, so the connection itself is fine.
      waiter.reject(new RouterConnectError(
        sentenceToMessage(waiter.failed), null, undefined, false))
    } else {
      waiter.resolve(waiter.rows)
    }
  }

  private failAll(err: Error): void {
    this.closedError = err
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.waiters = []
  }

  /** True once the session has been closed, by either side. */
  get isClosed(): boolean {
    return this.closedError !== null
  }

  /** Commands still in flight. Zero means the session is idle. */
  get pending(): number {
    return this.waiters.length
  }

  close(): void {
    this.failAll(new RouterConnectError('Session closed by the caller.'))
    this.channel.close()
  }
}

/** Pulls `=message=` (or any word) out of a `!fail` sentence. */
export function sentenceToMessage(sentence: Sentence): string {
  const row: Record<string, string> = {}
  for (const word of sentence.words) {
    if (!word.startsWith('=')) continue
    const eq = word.indexOf('=', 1)
    if (eq > 0) row[word.slice(1, eq)] = word.slice(eq + 1)
  }
  return row.message ?? (sentence.words.slice(1).join(' ') || 'RouterOS reported a failure')
}

/** True when a failure means "the object is already there": a no-op success. */
export function isAlreadyExists(message: string): boolean {
  const text = message.toLowerCase()
  return text.includes('already have such')
    || text.includes('already exists')
    || text.includes('already have entry')
}

/**
 * Is this an authentication problem rather than a fault?
 *
 * Retrying will not fix a wrong password, so the platform must report
 * AUTH FAILED rather than burning five attempts and then saying OFFLINE - which
 * sends an ISP to check cabling on a router whose password is simply wrong.
 */
export function isAuthFailure(error: Error | { message: string }): boolean {
  const text = error.message.toLowerCase()
  return text.includes('cannot log in')
    || text.includes('invalid user name or password')
    || text.includes('not allowed')
    || text.includes('permission denied')
    || text.includes('401')
    || text.includes('403')
}