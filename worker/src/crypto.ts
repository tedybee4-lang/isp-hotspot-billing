// =============================================================================
//  Router credential decryption (Node).
//
//  The format is the one the Edge Function writes: `v1.<iv>.<ciphertext>`,
//  AES-256-GCM, with the key derived by hashing ROUTER_CREDENTIALS_KEY.
//
//  The worker needs to read these because it is the process that actually opens
//  a socket to a router. Keeping the derivation identical to the Edge Function
//  is the point: one key, one format, no second way in.
//
//  There is deliberately no `encrypt` here. The worker only ever reads
//  credentials; only the Edge Function writes them, and only the panel ever
//  supplies the plaintext in the first place.
// =============================================================================

const ALGO = 'AES-GCM'
const IV_BYTES = 12
const VERSION = 'v1'

/**
 * Derives the AES key from the configured secret.
 *
 * The secret is hashed to exactly 32 bytes rather than used raw, so an operator
 * can set any passphrase without hitting an "invalid key length" error. This is
 * key derivation, not password storage: the value is a high-entropy secret held
 * in the worker environment.
 */
/**
 * Derives the AES key from the configured secret.
 *
 * The secret is hashed to exactly 32 bytes rather than used raw, so an operator
 * can set any passphrase without hitting an "invalid key length" error. This is
 * key derivation, not password storage: the value is a high-entropy secret held
 * in the worker environment.
 */
async function keyMaterial(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: ALGO }, false, ['decrypt'])
}

/** Decrypts one stored credential. Throws rather than returning a guess. */
export async function decryptSecret(payload: string, secret: string): Promise<string> {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in a recognised format.')
  }
  if (!secret) {
    throw new Error(
      'ROUTER_CREDENTIALS_KEY is not set. It must match the key the Edge '
      + 'Functions use, or stored credentials cannot be read.')
  }

  const key = await keyMaterial(secret)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: unb64(parts[1]) },
      key,
      unb64(parts[2]),
    )
    return new TextDecoder().decode(plain)
  } catch {
    // A wrong key and a tampered ciphertext both land here, and neither can be
    // told apart - nor should the message say which, in case it is tampered.
    throw new Error('Could not decrypt the stored router password.')
  }
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  // Node returns a Buffer view over a pooled ArrayBuffer; Web Crypto requires a
  // plain ArrayBuffer, so the bytes are copied into a fresh one.
  const src = Buffer.from(text, 'base64')
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}