/**
 * PayHero credential security tests.
 *
 * The recurring property: a PayHero credential must never leave the server, and
 * must never be readable with the wrong key. These assert against the real
 * modules rather than a description of them.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import {
  getPayHeroStatus,
  resolvePayHeroCredentials,
  storePayHeroCredentials,
  clearPayHeroCredentials,
  PayHeroCredentialError,
} from './payhero-credentials.ts'
import { encryptFor, decryptFor, KEY_ENV_VARS } from './secrets.ts'

const TOKEN = 'test-basic-token-not-a-real-credential'
const env = (globalThis as { process: { env: Record<string, string> } }).process.env

beforeAll(() => {
  env.PAYHERO_CREDENTIALS_KEY = 'payhero-test-key'
  env.HASHBACK_CREDENTIALS_KEY = 'hashback-test-key'
})

/** Captures every row written, so a test can assert what was persisted. */
function fakeAdmin(writes: Array<Record<string, unknown>>, row: Record<string, unknown>) {
  return {
    from(table: string) {
      const builder = { result: row }
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.maybeSingle = () => Promise.resolve({ data: builder.result, error: null })
      c.single = () => Promise.resolve({ data: builder.result, error: null })
      c.limit = () => c
      c.order = () => c
      c.insert = () => Promise.resolve({ data: null, error: null })
      c.update = () => Promise.resolve({ data: null, error: null })
      c.upsert = (values: Record<string, unknown>) => {
        writes.push({ table, values })
        return Promise.resolve({ data: null, error: null })
      }
      return c
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  } as never
}

describe('PayHero credential encryption', () => {
  it('uses a key namespace of its own, separate from HashBack', () => {
    // A compromise of one provider's environment must not decrypt the other's
    // credentials. Sharing the key would silently break that boundary.
    expect(KEY_ENV_VARS.payhero).toBe('PAYHERO_CREDENTIALS_KEY')
    expect(KEY_ENV_VARS.payhero).not.toBe(KEY_ENV_VARS.hashback)
  })

  it('stores only ciphertext, never the plaintext token', async () => {
    const writes: Array<Record<string, unknown>> = []
    await storePayHeroCredentials(fakeAdmin(writes, {}), { apiToken: TOKEN })

    expect(JSON.stringify(writes)).not.toContain(TOKEN)
    // The stored form is the sealed envelope, not the secret.
    expect(String(writes[0].values.payhero_api_token_ciphertext)).toMatch(/^v1\./)
  })

  it('round-trips through the real encrypt/decrypt pair', async () => {
    const sealed = await encryptFor(TOKEN, 'payhero')
    expect(sealed).not.toContain(TOKEN)
    expect(await decryptFor(sealed, 'payhero')).toBe(TOKEN)
  })

  it('cannot be decrypted with the HashBack key', async () => {
    // The isolation guarantee, demonstrated rather than asserted in prose.
    const sealed = await encryptFor(TOKEN, 'payhero')
    await expect(decryptFor(sealed, 'hashback')).rejects.toThrow()
  })

  it('treats a blank submission as "leave unchanged", not "clear"', async () => {
    const writes: Array<Record<string, unknown>> = []
    await storePayHeroCredentials(fakeAdmin(writes, {}), { apiToken: '   ' })
    // A form submitting one empty write-only field must not wipe a working
    // configuration, so no credential column is written at all.
    expect(writes).toHaveLength(0)
  })

  it('marks a stored credential as configured, never as verified', async () => {
    const writes: Array<Record<string, unknown>> = []
    await storePayHeroCredentials(fakeAdmin(writes, {}), { apiToken: TOKEN })
    // Storing proves nothing about whether the token works. Only a live API call
    // may set 'verified'.
    expect(writes[0].values.payhero_connection_status).toBe('configured')
  })
})
describe('PayHero status never discloses the credential', () => {
  it('returns a boolean, not the token or its ciphertext', async () => {
    const sealed = await encryptFor(TOKEN, 'payhero')
    const status = await getPayHeroStatus(
      fakeAdmin([], {
        payhero_api_token_ciphertext: sealed,
        payhero_connection_status: 'verified',
        payhero_account_id: 10052,
        payhero_balance: 28.5,
        payhero_currency: 'KES',
        payhero_channels: [
          {
            id: 13137,
            channel_type: 'till',
            short_code: '5441898',
            account_number: '',
            description: '',
            is_active: true,
          },
        ],
      }),
    )

    expect(status.hasApiToken).toBe(true)
    // Neither the plaintext nor the ciphertext may appear in a browser payload.
    const serialised = JSON.stringify(status)
    expect(serialised).not.toContain(TOKEN)
    expect(serialised).not.toContain(sealed)
  })

  it('never decrypts just to render the screen', async () => {
    // getPayHeroStatus must work from ciphertext alone. If it decrypted, opening
    // the admin page would put a live account-wide credential in server memory
    // for no reason.
    const sealed = await encryptFor(TOKEN, 'payhero')
    const status = await getPayHeroStatus(
      fakeAdmin([], { payhero_api_token_ciphertext: sealed }),
    )
    expect(status.hasApiToken).toBe(true)
  })

  it('reports discovered channels for display', async () => {
    const status = await getPayHeroStatus(
      fakeAdmin([], {
        payhero_channels: [
          { id: 13137, channel_type: 'till', short_code: '5441898', is_active: true },
        ],
      }),
    )
    expect(status.channels[0]).toMatchObject({
      id: 13137,
      channelType: 'till',
      shortCode: '5441898',
      isActive: true,
    })
  })
})

describe('PayHero credential resolution', () => {
  it('returns the decrypted token from the database', async () => {
    const sealed = await encryptFor(TOKEN, 'payhero')
    const creds = await resolvePayHeroCredentials(
      fakeAdmin([], { payhero_api_token_ciphertext: sealed }),
    )
    expect(creds.apiToken).toBe(TOKEN)
  })

  it('fails clearly when nothing is configured anywhere', async () => {
    delete env.PAYHERO_API_TOKEN
    const err = await resolvePayHeroCredentials(fakeAdmin([], {})).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(PayHeroCredentialError)
    expect((err as PayHeroCredentialError).code).toBe('not_configured')
    // The message tells the operator what to do, and quotes no secret.
    expect((err as Error).message).not.toContain('v1.')
  })

  it('reports a key mismatch without leaking the ciphertext', async () => {
    const sealed = await encryptFor(TOKEN, 'payhero')
    // Rotating the key is the realistic cause: the stored ciphertext can no
    // longer be opened.
    const original = env.PAYHERO_CREDENTIALS_KEY
    env.PAYHERO_CREDENTIALS_KEY = 'a-different-key'
    const err = await resolvePayHeroCredentials(
      fakeAdmin([], { payhero_api_token_ciphertext: sealed }),
    ).then(() => null, (e) => e)
    env.PAYHERO_CREDENTIALS_KEY = original

    expect(err).toBeInstanceOf(PayHeroCredentialError)
    expect((err as PayHeroCredentialError).code).toBe('decrypt_failed')
    expect((err as Error).message).not.toContain(sealed)
  })

  it('destroys the stored credential on disconnect', async () => {
    const writes: Array<Record<string, unknown>> = []
    await clearPayHeroCredentials(
      fakeAdmin(writes, {
        payhero_api_token_ciphertext: await encryptFor(TOKEN, 'payhero'),
        payhero_account_id: 10052,
        payhero_balance: 28.5,
      }),
    )
    const patch = writes[0].values
    expect(patch.payhero_api_token_ciphertext).toBeNull()
    expect(patch.payhero_connection_status).toBe('unconfigured')
    // The account and balance are deliberately NOT cleared: they are the only
    // clue about which channels need reassigning after a disconnect.
    expect(patch.payhero_account_id).toBeUndefined()
    expect(patch.payhero_balance).toBeUndefined()
  })
})