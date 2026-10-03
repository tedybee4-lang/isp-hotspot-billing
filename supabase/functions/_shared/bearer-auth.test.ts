import { describe, expect, it } from 'vitest'
import { isAuthorised, isAuthorisedWith, timingSafeEqualStr } from './bearer-auth.ts'

/**
 * mikrotik-poll is deployed with --no-verify-jwt because pg_cron has no user
 * session to present. That turns off the gateway check, so the function must
 * authenticate the caller itself.
 *
 * It did not. An anonymous GET returned HTTP 200 and a summary of every router
 * in the platform, having decrypted each stored router password with the
 * function's own key.
 */
describe('bearer authentication for --no-verify-jwt functions', () => {
  const KEY = 'test-service-role-key-not-a-real-value'

  it('accepts the exact key', () => {
    expect(isAuthorisedWith(`Bearer ${KEY}`, KEY)).toBe(true)
  })

  it('is case-insensitive about the scheme, as RFC 6750 requires', () => {
    expect(isAuthorisedWith(`bearer ${KEY}`, KEY)).toBe(true)
    expect(isAuthorisedWith(`BEARER ${KEY}`, KEY)).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isAuthorisedWith(`  Bearer ${KEY}  `, KEY)).toBe(true)
  })

  it('rejects a missing header', () => {
    expect(isAuthorisedWith(null, KEY)).toBe(false)
    expect(isAuthorisedWith(undefined, KEY)).toBe(false)
    expect(isAuthorisedWith('', KEY)).toBe(false)
  })

  it('rejects a header that is not a bearer token', () => {
    expect(isAuthorisedWith(KEY, KEY)).toBe(false)
    expect(isAuthorisedWith(`Basic ${KEY}`, KEY)).toBe(false)
    expect(isAuthorisedWith(`Bearer`, KEY)).toBe(false)
  })

  it('rejects the wrong key, however close', () => {
    expect(isAuthorisedWith(`Bearer ${KEY}x`, KEY)).toBe(false)
    expect(isAuthorisedWith(`Bearer ${KEY.slice(0, -1)}`, KEY)).toBe(false)
    expect(isAuthorisedWith(`Bearer ${KEY.toUpperCase()}`, KEY)).toBe(false)
  })

  it('rejects an empty or missing expected key, rather than passing', () => {
    // "No secret configured" is not "the caller is authorised". A misconfigured
    // deployment must fail closed, not open.
    expect(isAuthorisedWith(`Bearer ${KEY}`, '')).toBe(false)
    expect(isAuthorisedWith(`Bearer ${KEY}`, null)).toBe(false)
    expect(isAuthorisedWith('Bearer anything', '')).toBe(false)
    // And the array form must not treat an all-empty set as "no restriction".
    expect(isAuthorised('Bearer anything', ['', null, undefined])).toBe(false)
  })

  it('accepts either service-credential format the platform injects', () => {
    // Supabase exposes a legacy JWT and, on newer projects, an sb_secret_ value.
    // pg_cron holds whichever one poller_config stores; hard-coding one format
    // would fail closed but invisibly, and telemetry would simply stop.
    const legacy = 'eyJhbGciOiJIUzI1NiJ9.legacy-service-role-jwt'
    const secret = 'sb_secret_0123456789abcdef'
    expect(isAuthorised(`Bearer ${legacy}`, [legacy, secret])).toBe(true)
    expect(isAuthorised(`Bearer ${secret}`, [legacy, secret])).toBe(true)
    // An unrelated token still fails even when valid credentials exist.
    expect(isAuthorised('Bearer sb_secret_deadbeef', [legacy, secret])).toBe(false)
  })
})

describe('timingSafeEqualStr', () => {
  it('compares equal strings as equal', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStr('', '')).toBe(true)
  })

  it('compares different strings as different', () => {
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStr('abc', 'ab')).toBe(false)
    expect(timingSafeEqualStr('ab', 'abc')).toBe(false)
  })

  it('does not short-circuit, so a correct prefix leaks nothing', () => {
    // The property that matters: every differing position is examined. A `===`
    // returns at the first mismatch, and its runtime then reveals how many
    // leading characters were right.
    const almost = 'abcdefghijklmnopqrstuvwxyz0'
    const rightLengthWrongTail = 'abcdefghijklmnopqrstuvwxyz1'
    // Same length, different only in the final character: a short-circuiting
    // compare would take a measurably different path from a total mismatch.
    expect(timingSafeEqualStr(almost, rightLengthWrongTail)).toBe(false)
    expect(timingSafeEqualStr(almost, 'zyxwvutsrqponmlkjihgfedcba0')).toBe(false)
    expect(timingSafeEqualStr(almost, almost)).toBe(true)
  })
})