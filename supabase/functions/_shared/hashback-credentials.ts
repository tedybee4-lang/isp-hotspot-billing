// =============================================================================
//  Encrypted HashBack credential storage.
//
//  Server-side only. This is the single place that reads and writes the platform
//  HashBack credentials, and it is never imported by browser code.
//
//  Encryption reuses the application's existing scheme rather than adding a
//  second one: the AES-GCM format in `_shared/secrets.ts`
//  (`v1.<base64 iv>.<base64 ciphertext>`) under the `hashback` domain key. The
//  database stores only ciphertext, so a stolen service-role key or a leaked
//  dump does not yield a usable HashBack key.
//
//  What this module deliberately never does:
//    * return a credential to a caller that will serialise it,
//    * log one,
//    * accept one from a non-super-admin path.
// =============================================================================

import { encryptFor, decryptFor } from './secrets.ts'

/**
 * A Supabase client with the service role.
 *
 * Typed structurally rather than as `SupabaseClient` so this module does not
 * force a runtime import of the client library on callers that only pass their
 * own instance. Tests pass a fake with the same shape.
 *
 * `from()` returns a loose query-builder type on purpose. Making it precise
 * would mean hand-modelling supabase-js's whole fluent surface, and the
 * call-sites in this project immediately cast the result anyway.
 */
export type QueryResult = { data: unknown; error: { message: string } | null }

export type AdminClient = {
  from(table: string): QueryBuilder
  rpc(fn: string, args?: unknown): Promise<QueryResult>
  auth: {
    getUser(jwt: string): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  }
}

/**
 * The subset of a supabase-js query builder used here.
 *
 * Every method returns the builder itself, so calls chain; awaiting the builder
 * resolves to a QueryResult because it is thenable.
 *
 * The comparison filters are declared even though the real supabase-js builder
 * types them, because that library is loaded from a `https://` specifier at
 * runtime and cannot be resolved here. Omitting one is not harmless: the
 * `.neq`/`.not` filters below are what keep one ISP's Till from being read as
 * another ISP's revenue, so a missing declaration silently drops the filter.
 */
export type QueryBuilder = PromiseLike<QueryResult> & {
  select(columns?: string): QueryBuilder
  insert(values: unknown): QueryBuilder
  update(values: unknown): QueryBuilder
  upsert(values: unknown): PromiseLike<QueryResult>
  delete(): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  /** `neq(column, value)` → `column != value`. */
  neq(column: string, value: unknown): QueryBuilder
  /** `not(column, 'is', null)` → `column IS NOT NULL`. */
  not(column: string, operator: 'is' | 'eq' | 'gt' | 'lt', value: unknown): QueryBuilder
  is(column: string, value: unknown): QueryBuilder
  lt(column: string, value: unknown): QueryBuilder
  lte(column: string, value: unknown): QueryBuilder
  gt(column: string, value: unknown): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  in(column: string, values: readonly unknown[]): QueryBuilder
  maybeSingle(): QueryBuilder
  single(): QueryBuilder
  order(column: string, opts?: unknown): QueryBuilder
  limit(count: number): QueryBuilder
}

/**
 * The minimal shape of the Supabase client this module constructs.
 *
 * Declared locally rather than imported from supabase-js because that library is
 * loaded from a `https://` URL at runtime, which the Node type checker cannot
 * resolve. Only the two members actually used are described.
 */
interface SupabaseClientFactory {
  (url: string, key: string, options: {
    auth: { persistSession: boolean; autoRefreshToken: boolean }
  }): unknown
}

/** Non-secret status for the platform connection. Safe to show an operator. */
export interface PlatformCredentialStatus {
  connectionStatus: 'unconfigured' | 'configured' | 'verified' | 'failed'
  hasApiKey: boolean
  hasWebhookSecret: boolean
  lastVerifiedAt: string | null
  lastError: string | null
  tokenBalance: number | null
  partnerAccess: boolean | null
  webhookUrl: string | null
  providerMetadata: Record<string, unknown>
}

/**
 * Decrypted credentials, held only for the lifetime of one request.
 *
 * Named to make the danger obvious at every call site: anything reaching for
 * this must be server-side and must not put it in a response.
 */
export interface ResolvedPlatformCredentials {
  apiKey: string
  webhookSecret: string | null
}

const COLUMNS = [
  'hashback_api_key_encrypted',
  'hashback_webhook_secret_encrypted',
  'hashback_connection_status',
  'hashback_last_verified_at',
  'hashback_last_error',
  'hashback_token_balance',
  'hashback_partner_access',
  'hashback_webhook_url',
  'hashback_provider_metadata',
].join(', ')


/** Maps the database row to a safe status object. Never includes a ciphertext. */
function toStatus(row: Record<string, unknown> | null): PlatformCredentialStatus {
  const r = row ?? {}
  return {
    connectionStatus: (r.hashback_connection_status as PlatformCredentialStatus['connectionStatus'])
      ?? 'unconfigured',
    hasApiKey: typeof r.hashback_api_key_encrypted === 'string'
      && r.hashback_api_key_encrypted.length > 0,
    hasWebhookSecret: typeof r.hashback_webhook_secret_encrypted === 'string'
      && r.hashback_webhook_secret_encrypted.length > 0,
    lastVerifiedAt: (r.hashback_last_verified_at as string | null) ?? null,
    lastError: (r.hashback_last_error as string | null) ?? null,
    tokenBalance: typeof r.hashback_token_balance === 'number' ? r.hashback_token_balance : null,
    partnerAccess: typeof r.hashback_partner_access === 'boolean'
      ? r.hashback_partner_access : null,
    webhookUrl: (r.hashback_webhook_url as string | null) ?? null,
    providerMetadata: (r.hashback_provider_metadata as Record<string, unknown> | null) ?? {},
  }
}

/**
 * Reads the platform status without decrypting anything.
 *
 * Safe for an admin UI: it answers "is this configured?" without ever holding
 * the secret in memory, so there is nothing to leak by accident.
 */
export async function getPlatformCredentialStatus(
  admin: AdminClient,
): Promise<PlatformCredentialStatus> {
  const { data, error } = await admin
    .from('platform_payment_config')
    .select(COLUMNS)
    .eq('id', true)
    .maybeSingle()
  if (error) throw new Error(`reading HashBack status failed: ${error.message}`)
  return toStatus(data as Record<string, unknown> | null)
}

/**
 * Decrypts the platform credentials for server-side use.
 *
 * Returns null when nothing is configured, so a caller can report "not
 * configured" rather than throwing an opaque decryption error.
 */
export async function resolvePlatformCredentials(
  admin: AdminClient,
): Promise<ResolvedPlatformCredentials | null> {
  const { data, error } = await admin
    .from('platform_payment_config')
    .select('hashback_api_key_encrypted, hashback_webhook_secret_encrypted')
    .eq('id', true)
    .maybeSingle()

  if (error) throw new Error(`reading HashBack credentials failed: ${error.message}`)

  const row = data as {
    hashback_api_key_encrypted?: string | null
    hashback_webhook_secret_encrypted?: string | null
  } | null

  if (!row?.hashback_api_key_encrypted) return null

  return {
    apiKey: await decryptFor(row.hashback_api_key_encrypted, 'hashback'),
    webhookSecret: row.hashback_webhook_secret_encrypted
      ? await decryptFor(row.hashback_webhook_secret_encrypted, 'hashback')
      : null,
  }
}

/**
 * Encrypts and stores the platform credentials.
 *
 * Called only from a super-admin-gated Edge Function. An empty string means
 * "leave unchanged" rather than "clear", so a form that submits one masked
 * field cannot wipe a working configuration by accident.
 */
export async function storePlatformCredentials(
  admin: AdminClient,
  input: { apiKey?: string; webhookSecret?: string; webhookUrl?: string },
): Promise<PlatformCredentialStatus> {
  const patch: Record<string, unknown> = {}

  if (input.apiKey && input.apiKey.trim() !== '') {
    patch.hashback_api_key_encrypted =
      await encryptFor(input.apiKey.trim(), 'hashback')
    // A newly supplied key has not been verified yet. Saying 'verified' here
    // would let an admin screen show Connected before a single API call.
    patch.hashback_connection_status = 'configured'
    patch.hashback_last_error = null
  }
  if (input.webhookSecret && input.webhookSecret.trim() !== '') {
    patch.hashback_webhook_secret_encrypted =
      await encryptFor(input.webhookSecret.trim(), 'hashback')
  }
  if (input.webhookUrl !== undefined) {
    patch.hashback_webhook_url = input.webhookUrl || null
  }

  if (Object.keys(patch).length === 0) {
    // Nothing to change. Return the current status rather than writing a row.
    return getPlatformCredentialStatus(admin)
  }

  const { error } = await admin
    .from('platform_payment_config')
    .upsert({ id: true, ...patch, updated_at: new Date().toISOString() })

  if (error) throw new Error(`storing HashBack credentials failed: ${error.message}`)
  return getPlatformCredentialStatus(admin)
}

/**
 * Records the outcome of a real verification call.
 *
 * Only safe, provider-reported metadata is stored. The signature has no
 * credential parameter at all, so a leaked secret cannot be written here even by
 * mistake.
 */
export async function recordVerificationResult(
  admin: AdminClient,
  result: {
    connectionStatus: 'configured' | 'verified' | 'failed'
    lastError?: string | null
    tokenBalance?: number | null
    partnerAccess?: boolean | null
    providerMetadata?: Record<string, unknown>
  },
): Promise<PlatformCredentialStatus> {
  const patch: Record<string, unknown> = {
    hashback_connection_status: result.connectionStatus,
    hashback_last_verified_at: new Date().toISOString(),
    hashback_last_error: result.lastError ?? null,
  }
  if (result.tokenBalance !== undefined) patch.hashback_token_balance = result.tokenBalance
  if (result.partnerAccess !== undefined) {
    patch.hashback_partner_access = result.partnerAccess
  }
  if (result.providerMetadata) {
    patch.hashback_provider_metadata = result.providerMetadata
  }

  const { error } = await admin
    .from('platform_payment_config')
    .upsert({ id: true, ...patch, updated_at: new Date().toISOString() })

  if (error) throw new Error(`recording verification failed: ${error.message}`)
  return getPlatformCredentialStatus(admin)
}

/**
 * Reads an environment value from whichever runtime is present.
 *
 * Deno exposes `Deno.env`; Node exposes `process.env`. This module is imported
 * by Edge Functions *and* typechecked from the Node worker, so it must not
 * reference `Deno` unguarded — that is a compile error outside the Edge runtime
 * even though the function is never called there.
 */
function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno
  if (deno?.env?.get) return deno.env.get(name)
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

/**
 * Builds the admin client from the environment.
 *
 * Returns null when the environment is incomplete rather than throwing at import
 * time, so a misconfigured deployment produces a clear 500 at request time.
 *
 * The client library is imported dynamically rather than at the top of the file:
 * a static `https://` import cannot be resolved by Node's type checker, and this
 * module is shared with the Node-based worker.
 */
export async function adminFromEnv(): Promise<AdminClient | null> {
  const url = readEnv('SUPABASE_URL')
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return null
  const { createClient } = (await import(
    /* @vite-ignore */ 'https://esm.sh/@supabase/supabase-js@2'
  )) as { createClient: SupabaseClientFactory }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as AdminClient
}
