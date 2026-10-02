/**
 * Router credential decryption on the worker side.
 *
 * The worker and the Edge Function must read the same ciphertext with the same
 * key, or half the fleet becomes unmanageable the moment the worker starts. The
 * cross-implementation case is covered by decrypting a payload produced by the
 * Edge Function's own format here.
 */
import { describe, expect, it } from 'vitest'
import { decryptSecret } from './crypto.ts'
import { webcrypto } from 'node:crypto'

// Node exposes Web Crypto globally from 19 onwards; this keeps the module
// honest about which runtime API it depends on.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const KEY = 'a-high-entropy-secret-shared-with-the-edge-functions'

/** Mirrors supabase/functions/_shared/secrets.ts exactly. */
async function encryptLikeTheEdgeFunction(plaintext: string, secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey(
    'raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
  return ['v1', b64(iv), b64(sealed)].join('.')
}

describe('decryptSecret', () => {
  it('reads a credential written by the Edge Function', async () => {
    const payload = await encryptLikeTheEdgeFunction('SuperSecret123', KEY)
    expect(await decryptSecret(payload, KEY)).toBe('SuperSecret123')
  })

  it('round-trips a password containing = and unicode', async () => {
    const password = 'p@ss=w0rd✓ünïcode'
    const payload = await encryptLikeTheEdgeFunction(password, KEY)
    expect(await decryptSecret(payload, KEY)).toBe(password)
  })

  it('refuses a payload in an unknown format rather than guessing', async () => {
    await expect(decryptSecret('not-a-payload', KEY)).rejects.toThrow(/recognised format/)
    await expect(decryptSecret('v2.a.b', KEY)).rejects.toThrow(/recognised format/)
  })

  it('fails on the wrong key instead of returning garbage', async () => {
    const payload = await encryptLikeTheEdgeFunction('SuperSecret123', KEY)
    // The error must not say which of "wrong key" or "tampered" it was, so a
    // tamperer learns nothing from the message.
    await expect(decryptSecret(payload, 'a-different-secret')).rejects.toThrow()
  })

  it('fails loudly when no key is configured', async () => {
    const payload = await encryptLikeTheEdgeFunction('x', KEY)
    await expect(decryptSecret(payload, '')).rejects.toThrow(/ROUTER_CREDENTIALS_KEY/)
  })

  it('detects a tampered ciphertext', async () => {
    const payload = await encryptLikeTheEdgeFunction('SuperSecret123', KEY)
    const parts = payload.split('.')
    const bytes = Buffer.from(parts[2], 'base64')
    bytes[0] ^= 0xff                       // flip one bit
    parts[2] = bytes.toString('base64')
    await expect(decryptSecret(parts.join('.'), KEY)).rejects.toThrow(/Could not decrypt/)
  })
})