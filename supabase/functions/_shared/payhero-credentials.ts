// =============================================================================
//  Encrypted PayHero credential storage.
//
//  Server-side only. This is the single place that reads and writes the platform
//  PayHero credential, and it is never imported by browser code.
//
//  WHY A FORM EXISTS HERE AT ALL
//  -----------------------------
//  The requested experience was a "LOGIN / CONNECT PAYHERO" button that sends an
//  operator to PayHero to grant access. That was investigated and PayHero does not
//  support it: its documented authentication is a single static header,
//
//      Authorization: Basic <base64(username:password)>
//
//  with no OAuth, no Connect App, no delegated authorization and no token
//  lifecycle. There is no authorization page to redirect to, so a login button
//  would be theatre. An operator obtains the token from their own PayHero
//  dashboard and pastes it here ONCE. That is the whole unavoidable manual step,
//  and everything after it — verification, discovery, STK, settlement — is
//  automated.
//
//  WHY THE CREDENTIAL IS TREATED AS A PLATFORM SECRET
//  -------------------------------------------------
//  This is a long-lived account-wide password, not a scoped revocable token. It
//  authorises every operation on the account, including reading the balance and
//  pushing STK to any registered Till. So it is:
//    * stored only as AES-GCM ciphertext under its own domain key,
//    * readable only by the service role (no client SELECT policy on the table),
//    * never returned in any response, in whole or masked,
//    * never logged, never in an error message, never in a URL.
//
//  Encryption reuses the application's existing scheme rather than adding a
//  second one: the AES-GCM format in `_shared/secrets.ts`
//  (`v1.<base64 iv>.<base64 ciphertext>`) under the `payhero` domain key.
// =============================================================================

import { encryptFor, decryptFor } from './secrets.ts'
import type { AdminClient } from './hashback-credentials.ts'

/**
 * Non-secret status for the platform connection. Safe to show an operator and to
 * return to a browser.
 *
 * Every field here is either a boolean or a value PayHero itself reported. There
 * is deliberately no field that could carry any part of the credential.
 */
export interface PayHeroStatus {
  connectionStatus: 'unconfigured' | 'configured' | 'verified' | 'failed'
  /** Boolean only. The token itself is never returned. */
  hasApiToken: boolean
  lastVerifiedAt: string | null
  lastError: string | null
  /** PayHero account id, reported by the wallets endpoint. Not a credential. */
  accountId: number | null
  balance: number | null
  currency: string | null
  /** Channels discovered from the live API. Cache for display only. */
  channels: Array<{
    id: number
    channelType: string
    shortCode: string
    accountNumber: string
    description: string
    isActive: boolean
    /** Which ISP this channel is assigned to, or null when unassigned. */
    assignedIspId: string | null
  }>
  callbackUrl: string | null
}

/**
 * Decrypted credential, held only for the lifetime of one request.
 *
 * Named to make the danger obvious at every call site: anything reaching for
 * this must be server-side, must not log it, and must not put it in a response.
 */
export interface DecryptedPayHeroCredentials {
  readonly apiToken: string
}

export class PayHeroCredentialError extends Error {
  constructor(
    readonly code: 'not_configured' | 'decrypt_failed',
    message: string,
  ) {
    super(message)
    this.name = 'PayHeroCredentialError'
  }
}
/**
 * Resolves the PayHero Basic token.
 *
 * Two sources are supported, in this order:
 *
 *   1. `database` — the ciphertext a platform admin saved through the admin
 *      function. This is the normal production path.
 *   2. `environment` — the `PAYHERO_API_TOKEN` Edge Function secret. This exists
 *      so a deployment can be provisioned entirely through `supabase secrets set`
 *      without a browser session, and so the integration is testable before an
 *      admin has ever opened the screen.
 *
 * The environment fallback never logs, echoes or returns the value.
 *
 * Throws rather than returning null: every caller needs a credential to proceed,
 * and a silent null would surface later as a confusing 401 from PayHero that
 * looks like a provider outage.
 */
export async function resolvePayHeroCredentials(
  admin: AdminClient,
): Promise<DecryptedPayHeroCredentials> {
  const { data, error } = await admin
    .from('platform_payment_config')
    .select('payhero_api_token_ciphertext')
    .maybeSingle()

  if (error) {
    throw new PayHeroCredentialError('not_configured', 'Could not read the PayHero settings.')
  }

  const row = data as { payhero_api_token_ciphertext?: string | null } | null
  const ciphertext = row?.payhero_api_token_ciphertext

  if (ciphertext) {
    try {
      return { apiToken: await decryptFor(ciphertext, 'payhero') }
    } catch {
      // Almost always a rotated or mismatched PAYHERO_CREDENTIALS_KEY. The
      // message names the cause, never the ciphertext.
      throw new PayHeroCredentialError(
        'decrypt_failed',
        'The stored PayHero credential could not be decrypted. The encryption key may have changed.',
      )
    }
  }

  const fromEnv = readEnv('PAYHERO_API_TOKEN')?.trim()
  if (fromEnv) return { apiToken: fromEnv }

  throw new PayHeroCredentialError(
    'not_configured',
    'PayHero has not been configured yet. A platform administrator must save the PayHero API token.',
  )
}

/**
 * Reads the connection status WITHOUT decrypting.
 *
 * Viewing the admin screen must never put the credential in server memory, so this
 * selects booleans and provider-reported values only and never calls decryptFor.
 */
export async function getPayHeroStatus(admin: AdminClient): Promise<PayHeroStatus> {
  const { data, error } = await admin
    .from('platform_payment_config')
    .select(
      'payhero_api_token_ciphertext, payhero_connection_status, payhero_last_verified_at, ' +
        'payhero_last_error, payhero_account_id, payhero_balance, payhero_currency, ' +
        'payhero_channels, payhero_callback_url',
    )
    .maybeSingle()

  if (error) {
    throw new PayHeroCredentialError('not_configured', 'Could not read the PayHero settings.')
  }

  const row = (data ?? {}) as {
    payhero_api_token_ciphertext?: string | null
    payhero_connection_status?: string | null
    payhero_last_verified_at?: string | null
    payhero_last_error?: string | null
    payhero_account_id?: number | null
    payhero_balance?: number | null
    payhero_currency?: string | null
    payhero_channels?: unknown
    payhero_callback_url?: string | null
  }

  // Which discovered channels are already bound to a tenant, so the admin screen
  // can show that instead of offering a channel that is already spoken for.
  const assignments = await loadChannelAssignments(admin)
  const cached = Array.isArray(row.payhero_channels) ? row.payhero_channels : []

  const channels = cached.map((entry) => {
    const c = entry as {
      id?: number
      channel_type?: string
      short_code?: string
      account_number?: string
      description?: string
      is_active?: boolean
    }
    const id = Number(c.id)
    return {
      id,
      channelType: c.channel_type ?? '',
      shortCode: c.short_code ?? '',
      accountNumber: c.account_number ?? '',
      description: c.description ?? '',
      isActive: c.is_active !== false,
      assignedIspId: assignments[String(id)] ?? null,
    }
  })

  return {
    connectionStatus:
      (row.payhero_connection_status as PayHeroStatus['connectionStatus']) ?? 'unconfigured',
    // A boolean derived from presence. The token itself is not read or returned.
    hasApiToken:
      Boolean(row.payhero_api_token_ciphertext) || Boolean(readEnv('PAYHERO_API_TOKEN')),
    lastVerifiedAt: row.payhero_last_verified_at ?? null,
    lastError: row.payhero_last_error ?? null,
    accountId: row.payhero_account_id ?? null,
    balance: row.payhero_balance ?? null,
    currency: row.payhero_currency ?? null,
    channels,
    callbackUrl: row.payhero_callback_url ?? null,
  }
}

/** Maps channel id → ISP id for channels that are already assigned. */
async function loadChannelAssignments(admin: AdminClient): Promise<Record<string, string>> {
  const { data } = await admin
    .from('isp_payment_configs')
    .select('isp_id, payhero_channel_id')

  const rows = (data ?? []) as Array<{ isp_id?: string; payhero_channel_id?: number | null }>
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.isp_id && r.payhero_channel_id != null) out[String(r.payhero_channel_id)] = r.isp_id
  }
  return out
}
/**
 * Encrypts and stores the PayHero credential.
 *
 * An empty token means "leave unchanged", not "clear". A form that submits one
 * blank write-only field must not be able to wipe a working configuration.
 */
export async function storePayHeroCredentials(
  admin: AdminClient,
  input: { apiToken?: string; callbackUrl?: string | null },
): Promise<PayHeroStatus> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const token = input.apiToken?.trim() ?? ''

  if (token) {
    patch.payhero_api_token_ciphertext = await encryptFor(token, 'payhero')
    // 'configured', never 'verified': storing a credential proves nothing about
    // whether it works. Only a live API call may set 'verified'.
    patch.payhero_connection_status = 'configured'
    patch.payhero_last_error = null
  }

  if (input.callbackUrl !== undefined) {
    patch.payhero_callback_url = input.callbackUrl || null
  }

  if (Object.keys(patch).length === 1) {
    // Nothing to change; do not write a row for it.
    return getPayHeroStatus(admin)
  }

  const { error } = await admin
    .from('platform_payment_config')
    .upsert({ id: true, ...patch })

  if (error) {
    throw new PayHeroCredentialError(
      'not_configured',
      `Storing PayHero credentials failed: ${error.message}`,
    )
  }

  return getPayHeroStatus(admin)
}

/**
 * Records the outcome of a real verification call.
 *
 * Has no credential parameter at all, so a leaked secret cannot be written here
 * even by mistake.
 */
export async function recordPayHeroVerification(
  admin: AdminClient,
  result: {
    connectionStatus: 'configured' | 'verified' | 'failed'
    lastError?: string | null
    accountId?: number | null
    balance?: number | null
    currency?: string | null
    channels?: unknown
  },
): Promise<PayHeroStatus> {
  const patch: Record<string, unknown> = {
    payhero_connection_status: result.connectionStatus,
    payhero_last_verified_at: new Date().toISOString(),
    payhero_last_error: result.lastError ?? null,
  }
  if (result.accountId !== undefined) patch.payhero_account_id = result.accountId
  if (result.balance !== undefined) patch.payhero_balance = result.balance
  if (result.currency !== undefined) patch.payhero_currency = result.currency
  if (result.channels !== undefined) patch.payhero_channels = result.channels

  const { error } = await admin
    .from('platform_payment_config')
    .upsert({ id: true, ...patch })

  if (error) {
    throw new PayHeroCredentialError('not_configured', 'Recording verification failed.')
  }

  return getPayHeroStatus(admin)
}

/**
 * Clears the stored credential, leaving discovered metadata in place.
 *
 * The wallet balance and channel list are retained deliberately: after a
 * disconnect an operator can still see what the account looked like, and clearing
 * them would destroy the only clue about which channels need reassigning.
 */
export async function clearPayHeroCredentials(admin: AdminClient): Promise<PayHeroStatus> {
  const { error } = await admin
    .from('platform_payment_config')
    .upsert({
      id: true,
      payhero_api_token_ciphertext: null,
      payhero_connection_status: 'unconfigured',
      payhero_last_error: null,
      updated_at: new Date().toISOString(),
    })

  if (error) {
    throw new PayHeroCredentialError('not_configured', 'Disconnecting PayHero failed.')
  }

  return getPayHeroStatus(admin)
}

/**
 * Reads an environment value from whichever runtime is present.
 *
 * Deno exposes `Deno.env`; Node exposes `process.env`. This module is imported by
 * Edge Functions *and* typechecked from the Node worker, so it must not reference
 * `Deno` unguarded — that is a compile error outside the Edge runtime even though
 * the function is never called there.
 */
function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno
  if (deno?.env?.get) return deno.env.get(name)
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}