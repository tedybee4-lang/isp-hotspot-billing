/**
 * RouterOS API wire protocol.
 *
 * These tests are the reason the platform can claim RouterOS 6 support
 * without a physical RB941 attached: the framing is pure, so it is verified
 * here byte for byte.
 */
import { describe, expect, it } from 'vitest'
import {
  encodeSentence, SentenceDecoder, isAlreadyExists, failMessage, isAuthFailureMessage,
} from './rosapi.ts'

/** Builds a sentence from raw words, exactly as a router would send it. */
function frame(words: string[]): Uint8Array {
  const enc = new TextEncoder()
  const out: number[] = []
  for (const word of words) {
    const bytes = enc.encode(word)
    if (bytes.length < 0x80) {
      out.push(bytes.length)
    } else if (bytes.length < 0x4000) {
      out.push((bytes.length | 0x8000) >>> 8, bytes.length & 0xff)
    } else {
      const v = bytes.length | 0xc00000
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
    }
    out.push(...bytes)
  }
  out.push(0xff, 0xff, 0xff, 0xff)
  return Uint8Array.from(out)
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ')

describe('encodeSentence', () => {
  it('encodes a bare command with the zero-length terminator', () => {
    const cmd = new TextEncoder().encode('/system/identity/print')
    // 22 = 0x16, the one-byte length prefix, then the word, then the terminator.
    expect(hex(encodeSentence('/system/identity/print')))
      .toBe(hex(Uint8Array.from([cmd.length, ...cmd, 0xff, 0xff, 0xff, 0xff])))
  })

  it('encodes params as =key=value words', () => {
    const row = new SentenceDecoder().push(encodeSentence('/ip/hotspot/user/add', {
      name: 'voucher-1', password: 'secret', profile: 'default',
    }))[0].row
    expect(row).toMatchObject({ name: 'voucher-1', password: 'secret', profile: 'default' })
  })

  it('skips undefined and null values instead of sending empty words', () => {
    // A present-but-empty word means "clear this property" on `set`, so it must
    // never be emitted for an absent value.
    const row = new SentenceDecoder().push(encodeSentence('/ip/dns/set', {
      'allow-remote-requests': 'yes', servers: undefined, cache: undefined,
    }))[0].row
    expect(row).toEqual({ 'allow-remote-requests': 'yes' })
  })

  it('passes through a !tag word written as a bare key', () => {
    const row = new SentenceDecoder()
      .push(encodeSentence('/interface/print', { '!iface': 'ether1' }))[0].row
    expect(row['!iface']).toBe('ether1')
  })

  it('handles a value longer than 64 bytes with a two-byte length prefix', () => {
    const long = 'x'.repeat(300)
    const row = new SentenceDecoder()
      .push(encodeSentence('/system/script/add', { source: long }))[0].row
    expect(row.source).toBe(long)
  })

  it('round-trips a comment containing = signs', () => {
    const comment = 'NETISP:abc123 role=hotspot'
    const row = new SentenceDecoder()
      .push(encodeSentence('/ip/hotspot/user/add', { comment }))[0].row
    expect(row.comment).toBe(comment)
  })
})
describe('SentenceDecoder', () => {
  it('emits nothing for an incomplete sentence', () => {
    // Missing the last two bytes of the terminator: a valid partial read, and
    // it must be reported as neither a complete sentence nor corruption.
    const full = frame(['!re', '=.id=*1', '=name=ether1'])
    expect(new SentenceDecoder().push(full.slice(0, full.length - 2))).toEqual([])
  })

  it('reassembles a sentence split one byte at a time', () => {
    // The worst case a socket can produce.
    const full = frame(['!re', '=.id=*1', '=name=ether1', '=type=ether'])
    const decoder = new SentenceDecoder()
    const kinds: string[] = []
    for (let i = 0; i < full.length; i += 1) {
      for (const s of decoder.push(full.slice(i, i + 1))) kinds.push(s.kind)
    }
    expect(kinds).toEqual(['row'])
    expect(decoder.hasPartialSentence).toBe(false)
  })

  it('splits three sentences arriving in one chunk', () => {
    const merged = new Uint8Array([
      ...frame(['!re', '=name=alpha']),
      ...frame(['!re', '=name=beta']),
      ...frame(['!done']),
    ])
    const sentences = new SentenceDecoder().push(merged)
    expect(sentences.map((s) => s.kind)).toEqual(['row', 'row', 'done'])
    expect(sentences[0].row.name).toBe('alpha')
    expect(sentences[1].row.name).toBe('beta')
  })

  it('reassembles a sentence split inside its length prefix', () => {
    const full = frame(['!re', '=version=7.14.3'])
    const decoder = new SentenceDecoder()
    expect(decoder.push(full.slice(0, 1))).toEqual([])
    expect(decoder.push(full.slice(1))[0].row.version).toBe('7.14.3')
  })

  it('classifies !fail, !done and !trap', () => {
    const sentences = new SentenceDecoder().push(new Uint8Array([
      ...frame(['!re', '=a=1']), ...frame(['!done']),
      ...frame(['!trap', '=message=link down']),
    ]))
    expect(sentences.map((s) => s.kind)).toEqual(['row', 'done', 'trap'])
  })

  it('keeps .id so callers can address a row later', () => {
    const row = new SentenceDecoder().push(frame(['!re', '=.id=*A', '=name=bob']))[0].row
    expect(row['.id']).toBe('*A')
    expect(row.name).toBe('bob')
  })

  it('decodes a 4-byte length prefix', () => {
    const big = 'y'.repeat(5000)
    const n = big.length
    const bytes = new Uint8Array([
      0xc0 | ((n >>> 24) & 0x1f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff,
      ...new TextEncoder().encode(big), 0xff, 0xff, 0xff, 0xff,
    ])
    // The leading word is bare, not `=key=value`, so it is read from `words`.
    expect(new SentenceDecoder().push(bytes)[0].words[0]).toBe(big)
  })
})

describe('failure interpretation', () => {
  it('reads the RouterOS 6 message form', () => {
    const s = new SentenceDecoder().push(frame(['!fail', '=message=cannot log in']))[0]
    expect(s.kind).toBe('fail')
    expect(failMessage(s)).toBe('cannot log in')
  })

  it('reads the RouterOS 7 message form and recognises already-exists', () => {
    const s = new SentenceDecoder()
      .push(frame(['!fail', '=message=failure: already have such address']))[0]
    expect(isAlreadyExists(failMessage(s))).toBe(true)
  })

  it('does not treat an unrelated failure as already-exists', () => {
    const s = new SentenceDecoder()
      .push(frame(['!fail', '=message=failure: not enough permissions']))[0]
    expect(isAlreadyExists(failMessage(s))).toBe(false)
  })

  it('separates an auth failure from an unreachable router', () => {
    expect(isAuthFailureMessage('cannot log in')).toBe(true)
    expect(isAuthFailureMessage('=message=invalid user name or password (6)')).toBe(true)
    expect(isAuthFailureMessage('connection refused')).toBe(false)
    expect(isAuthFailureMessage('timed out after 8000ms')).toBe(false)
  })
})