// =============================================================================
//  Credential encryption.
//  Secrets are encrypted with a key that lives ONLY in the Edge Function
//  environment. The database stores ciphertext; it never sees the key. A stolen
//  service-role key or a leaked database dump therefore does not yield a usable
//  plaintext secret.
//
//  Format:  v1.<base64(iv)>.<base64(ciphertext)>
//
//  Key names are namespaced per domain. ROUTER_CREDENTIALS_KEY,
//  HASHBACK_CREDENTIALS_KEY and PAYHERO_CREDENTIALS_KEY derive different AES keys
//  from the same scheme, so a compromise of one domain's environment cannot
//  decrypt the other's secrets. The scheme is shared; the key material is not.
//
//  The per-provider separation is not theoretical tidiness. HashBack keys and
//  PayHero Basic credentials are issued and rotated independently, and a support
//  engineer debugging one provider should not be able to read the other. PayHero's
//  credential is a long-lived account-wide password rather than a scoped key,
//  which makes that isolation more valuable, not less.
// =============================================================================

const ALGO = 'AES-GCM'
const IV_BYTES = 12
const VERSION = 'v1'

/** Which environment secret holds the key for a given domain. */
export const KEY_ENV_VARS = {
  router: 'ROUTER_CREDENTIALS_KEY',
  hashback: 'HASHBACK_CREDENTIALS_KEY',
  payhero: 'PAYHERO_CREDENTIALS_KEY',
} as const

export type CredentialDomain = keyof typeof KEY_ENV_VARS

/**
 * Reads an environment secret.
 *
 * Deno exposes `Deno.env`; Node exposes `process.env`. This module is imported
 * by Edge Functions *and* exercised by Node-based unit tests, so it reads
 * whichever is present rather than assuming a runtime. An unset variable returns
 * null on both, and the caller's error message is unchanged.
 */
function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno
  if (deno?.env?.get) return deno.env.get(name)
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

/**
 * Derives the AES key for a domain from its configured secret.
 *
 * The secret is hashed to exactly 32 bytes rather than used raw, so an operator
 * can set any passphrase without hitting an "invalid key length" error at the
 * worst possible moment. This is key derivation, not password storage: the value
 * is a high-entropy secret held in the function environment.
 */
async function keyMaterial(domain: CredentialDomain): Promise<CryptoKey> {
  const envName = KEY_ENV_VARS[domain]
  const secret = readEnv(envName)
  if (!secret) {
    throw new Error(
      `${envName} is not set. Run: supabase secrets set ${envName}=$(openssl rand -base64 32)`,
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

/** Encrypts for the router-credential domain. */
export async function encryptSecret(plaintext: string): Promise<string> {
  return encryptFor(plaintext, 'router')
}

/** Decrypts for the router-credential domain. */
export async function decryptSecret(payload: string): Promise<string> {
  return decryptFor(payload, 'router')
}

/**
 * Encrypts under a named domain's key.
 *
 * The returned payload carries no domain marker, so decryption must be given the
 * same domain it was encrypted with. Every call site here encrypts and decrypts
 * the same column, so that holds — and putting the domain in the payload would
 * leak which secrets exist to anyone holding the ciphertext.
 */
export async function encryptFor(
  plaintext: string,
  domain: CredentialDomain,
): Promise<string> {
  const key = await keyMaterial(domain)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const data = new TextEncoder().encode(plaintext)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv }, key, data),
  )
  return [VERSION, b64(iv), b64(sealed)].join('.')
}

/** Decrypts a payload produced by encryptFor for the same domain. */
export async function decryptFor(
  payload: string,
  domain: CredentialDomain,
): Promise<string> {
  const parts = payload.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in a recognised format.')
  }
  const key = await keyMaterial(domain)
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: unb64(parts[1]) },
      key,
      unb64(parts[2]),
    )
    return new TextDecoder().decode(plain)
  } catch {
    // A wrong key or tampered ciphertext both land here, and the message must
    // not distinguish them: that would tell an attacker which half they got
    // right.
    throw new Error('Could not decrypt the stored credential.')
  }
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Decodes base64 into bytes Web Crypto will accept.
 *
 * The explicit `Uint8Array<ArrayBuffer>` return type is deliberate: `atob` hands
 * back a view over a buffer typed as `ArrayBufferLike`, which newer TypeScript
 * lib definitions reject as a `BufferSource`. Building the array from `length`
 * guarantees a plain `ArrayBuffer` and keeps this in step with the worker's
 * copy of the same routine.
 */
function unb64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}
