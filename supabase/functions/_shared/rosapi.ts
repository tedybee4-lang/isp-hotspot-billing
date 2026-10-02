// =============================================================================
//  RouterOS API - wire protocol
//
//  This is the binary protocol MikroTik has exposed since RouterOS 2.8, and it
//  is the only transport that works on every device the platform must manage.
//  The RB941-2nD / hAP lite (SMIPS, RouterOS 6.x) has no REST service at all,
//  so a REST-only client simply cannot reach it.
//
//  The protocol is deliberately transport-agnostic: `encodeSentence` turns a
//  command into bytes and `SentenceDecoder` turns bytes back into sentences.
//  A WebSocket (Edge Functions, which cannot open raw TCP) and a TCP socket
//  (the VPS worker, which should use one) therefore share exactly one
//  implementation and cannot drift apart.
//
//  Wire format
//  -----------
//  A word is a length prefix followed by that many bytes:
//
//      len < 0x80              1 byte
//      len < 0x4000            2 bytes, first |= 0x80
//      len < 0x200000          4 bytes, first |= 0xC0
//      len < 0x10000000        8 bytes, first |= 0xE0
//      zero-length word        encoded as 0xFF 0xFF 0xFF 0xFF
//
//  A sentence is a sequence of words terminated by a zero-length word. The
//  first word of a reply sentence is one of:
//
//      !re    a row
//      !done  the command finished successfully
//      !fail  the command failed
//      !trap  an asynchronous error not tied to a command (hangup, etc.)
//
//  Everything here is pure and synchronous. It has no sockets, so it can be
//  unit tested without a router, which is how the hAP lite and CHR paths are
//  covered on a machine that has no MikroTik hardware attached.
// =============================================================================

export type Word = string

export const RE_PREFIX = '!re'
export const DONE = '!done'
export const FAIL = '!fail'
export const TRAP = '!trap'

const ZLEN = [0xff, 0xff, 0xff, 0xff]

/** Length prefix for one word. */
function encodeLength(len: number): number[] {
  if (len < 0x80) return [len]
  if (len < 0x4000) return [(len | 0x8000) >>> 8, len & 0xff]
  if (len < 0x200000) {
    const v = len | 0xc00000
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  }
  if (len < 0x10000000) {
    const v = len | 0xe0000000
    return [0, 0, 0, 0,
      (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
  }
  throw new RangeError(`Word too long to encode: ${len} bytes`)
}

/**
 * Reads one length prefix.
 *
 * Returns `null` - not an error - when the buffer simply does not hold enough
 * bytes yet. TCP delivers arbitrary chunk boundaries, so a 2- or 4-byte prefix
 * can be split across two reads; treating that as corruption would kill a
 * healthy connection at random.
 */
function decodeLength(
  buf: Uint8Array,
  off: number,
): { len: number; size: number } | null {
  const b0 = buf[off]
  if (b0 === undefined) return null

  // The end-of-sentence marker is the all-ones prefix, which matches none of
  // the normal size classes. It must be tested first or it falls through to the
  // "unrecognised" branch below.
  if (b0 === 0xff) {
    if (off + 4 > buf.length) return null                 // wait for the rest
    if (buf[off + 1] === 0xff && buf[off + 2] === 0xff && buf[off + 3] === 0xff) {
      return { len: 0, size: 4 }
    }
    throw new Error(`Unrecognised length prefix 0xff at offset ${off}`)
  }

  if (b0 < 0x80) return { len: b0, size: 1 }

  if ((b0 & 0xc0) === 0x80) {
    if (off + 2 > buf.length) return null
    return { len: ((b0 & 0x3f) << 8) | buf[off + 1], size: 2 }
  }

  if ((b0 & 0xe0) === 0xc0) {
    if (off + 4 > buf.length) return null
    return {
      len: (b0 & 0x1f) * 0x1000000
        + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3],
      size: 4,
    }
  }

  if ((b0 & 0xf0) === 0xe0) {
    if (off + 8 > buf.length) return null
    return {
      len: buf[off + 4] * 0x1000000
        + (buf[off + 5] << 16) + (buf[off + 6] << 8) + buf[off + 7],
      size: 8,
    }
  }

  throw new Error(`Unrecognised length prefix 0x${b0.toString(16)} at offset ${off}`)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Encodes one command into a sentence.
 *
 * `command` is the path, e.g. `/ip/hotspot/user/add`. Params become `=key=value`
 * words. A key that already starts with `=` is written verbatim, which is how a
 * `!tag` word (`!iface=ether1`) is expressed.
 *
 * Params whose value is undefined or null are skipped rather than sent as an
 * empty word: RouterOS reads a present-but-empty word as "clear this property"
 * on `set`, and rejects it outright on `add`.
 */
export function encodeSentence(
  command: string,
  params: Record<string, string | undefined> = {},
): Uint8Array {
  const words: string[] = [command]
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    words.push(key.startsWith('=') ? `${key}=${value}` : `=${key}=${value}`)
  }

  const out: number[] = []
  for (const word of words) {
    const bytes = encoder.encode(word)
    out.push(...encodeLength(bytes.length), ...bytes)
  }
  out.push(...ZLEN)
  return Uint8Array.from(out)
}
export type SentenceKind = 'row' | 'done' | 'fail' | 'trap'

export interface Sentence {
  kind: SentenceKind
  words: string[]
  /** A `!re` row as a plain object. `.id` is preserved as a normal key. */
  row: Record<string, string>
}

/** `=key=value` -> row object. A bare `!tag` becomes row['!tag']. */
function wordsToRow(words: string[]): Record<string, string> {
  const row: Record<string, string> = {}
  for (const word of words) {
    if (!word.startsWith('=')) continue
    const eq = word.indexOf('=', 1)
    if (eq < 0) {
      row[word.slice(1)] = ''
      continue
    }
    row[word.slice(1, eq)] = word.slice(eq + 1)
  }
  return row
}

function classify(words: string[]): Sentence {
  const head = words[0]
  if (head === DONE) return { kind: 'done', words, row: {} }
  if (head === FAIL) return { kind: 'fail', words, row: {} }
  if (head === TRAP) return { kind: 'trap', words, row: {} }
  // `!re`, or a head we do not recognise. Either way it is data; surfacing it
  // is safer than silently dropping it.
  return { kind: 'row', words, row: wordsToRow(words) }
}

/**
 * Incremental decoder.
 *
 * TCP and WebSocket both deliver arbitrary chunk boundaries: one sentence can
 * arrive split across three chunks, and three sentences can arrive in one.
 * Buffering here and emitting only whole sentences is what makes that invisible
 * to the caller.
 */
export class SentenceDecoder {
  private buffer = new Uint8Array(0)
  private words: string[] = []

  /** Feeds bytes in, returns whatever complete sentences are now available. */
  push(chunk: Uint8Array): Sentence[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buffer.length + chunk.length)
      merged.set(this.buffer, 0)
      merged.set(chunk, this.buffer.length)
      this.buffer = merged
    }

    const out: Sentence[] = []
    let off = 0

    while (off < this.buffer.length) {
      const header = decodeLength(this.buffer, off)
      if (header === null) break      // need more bytes; keep the tail
      const { len, size } = header

      if (len === 0) {
        // End of this sentence.
        off += size
        out.push(classify(this.words))
        this.words = []
        continue
      }

      if (off + size + len > this.buffer.length) break   // wait for the word
      const start = off + size
      this.words.push(decoder.decode(this.buffer.subarray(start, start + len)))
      off = start + len
    }

    // Keep the partial tail for the next chunk.
    this.buffer = off === 0 ? this.buffer : this.buffer.slice(off)
    return out
  }

  /** True when a sentence is half-read and the connection ended mid-word. */
  get hasPartialSentence(): boolean {
    return this.words.length > 0
  }
}

/**
 * The error text RouterOS puts on a `!fail` sentence, if any.
 *
 * RouterOS 6 sends `=message=cannot log in`; 7.x sends
 * `=message=failure: already have such address`. Both are wanted verbatim,
 * because "already have such address" is how the platform learns a voucher
 * already exists rather than that the create genuinely failed.
 */
export function failMessage(sentence: Sentence): string {
  const row = wordsToRow(sentence.words.slice(1))
  return row.message ?? sentence.words.slice(1).join(' ') ?? 'no reason given'
}

/** True when a failure means "the object is already there": a no-op success. */
export function isAlreadyExists(message: string): boolean {
  const text = message.toLowerCase()
  return text.includes('already have such')
    || text.includes('already exists')
    || text.includes('already have entry')
}

/** True when a failure is an authentication problem rather than a fault. */
export function isAuthFailureMessage(message: string): boolean {
  const text = message.toLowerCase()
  return text.includes('cannot log in')
    || text.includes('invalid user name or password')
    || text.includes('not allowed')
    || text.includes('permission denied')
    || text.includes('401')
}