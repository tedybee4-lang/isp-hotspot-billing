// =============================================================================
//  Router credential encryption.
//
//  RouterOS passwords are encrypted here with a key that lives ONLY in the Edge
//  Function environment (ROUTER_CREDENTIALS_KEY). The database stores
//  ciphertext; it never sees the key. A stolen service-role key therefore does
//  not yield plaintext router passwords.
//
//  Format:  v1.<base64(iv)>.<base64(ciphertext)>
// =============================================================================

const ALGO = 'AES-GCM'
const IV_BYTES = 12
const VERSION = 'v1'

/**
 * Derives the AES key from the configured secret.
 *
 * The secret is hashed to exactly 32 bytes rather than used raw, so an operator
 * can set any passphrase without hitting an "invalid key length" error at the
 * worst possible moment. This is key derivation, not password storage: the value
 * is a high-entropy secret held in the function environment.
 */
async function keyMaterial(): Promise<CryptoKey> {
  const secret = Deno.env.get('ROUTER_CREDENTIALS_KEY')
  if (!secret) {
    throw new Error(
      'ROUTER_CREDENTIALS_KEY is not set. Run: supabase secrets set ROUTER_CREDENTIALS_KEY=$(openssl rand -base64 32)',
    )
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  )
  return crypto.subtle.importKey('raw', digest, { name: ALGO }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await keyMaterial()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const data = new TextEncoder().encode(plaintext)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv }, key, data),
  )
  return [VERSION, b64(iv), b64(sealed)].join('.')
}

export async function decryptSecret(payload: string): Promise<string> {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in a recognised format.')
  }
  const key = await keyMaterial()
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: unb64(parts[1]) },
      key,
      unb64(parts[2]),
    )
    return new TextDecoder().decode(plain)
  } catch {
    // A wrong key or tampered ciphertext both land here.
    throw new Error('Could not decrypt the stored router password.')
  }
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function unb64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}