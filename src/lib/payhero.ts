// =============================================================================
//  Browser-facing PayHero API.
//
//  A thin call layer for the PayHero Edge Functions. It deliberately contains NO
//  PayHero credential and no provider logic: the token is posted once to
//  `payhero-admin`, encrypted server-side, and never returned here. Nothing in
//  this file can read, log or forward it.
//
//  Note there is no `loginPayHero()` and that omission is the point. PayHero has
//  no OAuth or delegated authorization to complete, so there is no redirect to
//  perform. See _shared/payhero.ts for the verification of that finding.
// =============================================================================

import { requireSupabase, functionsUrl } from './supabase'
import { IS_LIVE, config } from './config'
import { PaymentError } from './payments'

// Re-exported so an admin screen needs one import for the whole PayHero surface.
// It is the shared error type, not a PayHero-specific one.
export { PaymentError }

/** Non-secret platform connection state. Never contains a token or ciphertext. */
export interface PayHeroPlatformStatus {
  connectionStatus: 'unconfigured' | 'configured' | 'verified' | 'failed'
  /** Boolean only. The token itself is never returned by any endpoint. */
  hasApiToken: boolean
  lastVerifiedAt: string | null
  lastError: string | null
  /** PayHero account id. Reported by PayHero; not a credential. */
  accountId: number | null
  balance: number | null
  currency: string | null
  channels: PayHeroChannelSummary[]
  callbackUrl: string | null
}

/** One discovered PayHero Till/PayBill. Identifiers, never secrets. */
export interface PayHeroChannelSummary {
  id: number
  channelType: string
  shortCode: string
  accountNumber: string
  description: string
  isActive: boolean
  /** The ISP this channel is bound to, or null when available. */
  assignedIspId?: string | null
}

/** The outcome of a real verification call against PayHero. */
export interface PayHeroVerificationResult {
  apiAvailable: boolean
  accountId: number | null
  balance: number | null
  currency: string | null
  channels: PayHeroChannelSummary[]
  status: PayHeroPlatformStatus
}

async function callPayHeroAdmin(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sb = requireSupabase()
  const { data: sess } = await sb.auth.getSession()
  const res = await fetch(functionsUrl('payhero-admin'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
      apikey: config.supabaseAnonKey,
    },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new PaymentError(
      (body as { error?: string }).error ?? 'The request failed.',
    )
  }
  return body as Record<string, unknown>
}

/** Reads platform connection status without decrypting anything. */
export async function fetchPayHeroStatus(): Promise<PayHeroPlatformStatus | null> {
  if (!IS_LIVE) return null
  const body = await callPayHeroAdmin({ action: 'status' })
  return (body.status as PayHeroPlatformStatus) ?? null
}

/**
 * Stores the PayHero Basic API token.
 *
 * The token is posted once over TLS to an Edge Function that encrypts it before
 * writing. It is never placed in localStorage, never logged, and never returned —
 * the response carries only booleans.
 */
export async function savePayHeroCredentials(input: {
  apiToken?: string
  callbackUrl?: string | null
}): Promise<PayHeroPlatformStatus | null> {
  const body = await callPayHeroAdmin({ action: 'save', ...input })
  return (body.status as PayHeroPlatformStatus) ?? null
}
/**
 * Verifies the connection against PayHero's live API.
 *
 * Every reported value was returned by PayHero itself. The balance is the account
 * figure, not an estimate, and the channel list is the live inventory.
 */
export async function verifyPayHeroConnection(): Promise<PayHeroVerificationResult> {
  const body = await callPayHeroAdmin({ action: 'verify' })
  return toVerificationResult(body)
}

/** Re-reads the channel inventory without altering the recorded verdict. */
export async function refreshPayHeroChannels(): Promise<PayHeroVerificationResult> {
  const body = await callPayHeroAdmin({ action: 'refresh' })
  return toVerificationResult(body)
}

function toVerificationResult(body: Record<string, unknown>): PayHeroVerificationResult {
  return {
    apiAvailable: Boolean(body.apiAvailable),
    accountId: (body.accountId as number | null) ?? null,
    balance: (body.balance as number | null) ?? null,
    currency: (body.currency as string | null) ?? null,
    channels: (body.channels as PayHeroChannelSummary[]) ?? [],
    status: body.status as PayHeroPlatformStatus,
  }
}

/** One ISP a channel may be assigned to. Carries no credential. */
export interface PayHeroIspOption {
  id: string
  name: string
  /** What this tenant collects with today, so a reassignment is a conscious act. */
  currentProvider: string | null
  currentChannelId: number | null
  connectionStatus: string
}

/**
 * Lists the tenants a channel may be assigned to.
 *
 * Returned so the admin screen can offer a named list instead of asking anyone to
 * paste a UUID. Picking the wrong tenant routes a customer's money to the wrong
 * merchant, so the current provider is surfaced alongside each option rather than
 * hidden.
 */
export async function fetchPayHeroIsps(): Promise<PayHeroIspOption[]> {
  const body = await callPayHeroAdmin({ action: 'isps' })
  return (body.isps as PayHeroIspOption[]) ?? []
}

/**
 * Assigns one discovered channel to one ISP.
 *
 * The one-channel-one-ISP rule is enforced in the database, so this cannot be
 * used to point two tenants at the same Till even with a crafted request.
 */
export async function assignPayHeroChannel(
  ispId: string,
  channelId: number,
): Promise<PayHeroPlatformStatus | null> {
  const body = await callPayHeroAdmin({ action: 'assign', ispId, channelId })
  return (body.status as PayHeroPlatformStatus) ?? null
}

/** Clears the stored credential. Discovered balance and channels are retained. */
export async function disconnectPayHero(): Promise<PayHeroPlatformStatus | null> {
  const body = await callPayHeroAdmin({ action: 'disconnect' })
  return (body.status as PayHeroPlatformStatus) ?? null
}

/** What the backend says about a provisioning attempt. Never optimistic. */
export interface PayHeroProvisioningResult {
  ok: boolean
  /** READY only when PayHero confirmed a channel. Never faked. */
  status: 'pending' | 'ready' | 'failed'
  channelId: number | null
  /** True only when a NEW channel was created at PayHero. */
  created: boolean
  /** Safe, ISP-facing sentence produced server-side. */
  message: string
  code?: string | null
}

/**
 * Registers (or reuses) this tenant's PayHero channel for a Till number.
 *
 * Called after the ISP saves their Till. The Till is the only thing sent: the ISP
 * is resolved server-side from the caller's session, so this cannot be pointed at
 * another tenant. The result is real backend state — READY is only ever returned
 * when PayHero actually confirmed a channel.
 */
export async function provisionPayHeroChannel(
  shortCode: string,
): Promise<PayHeroProvisioningResult> {
  if (!IS_LIVE) {
    return {
      ok: false,
      status: 'failed',
      channelId: null,
      created: false,
      message: 'Demo mode: no payment channel is registered.',
      code: 'demo_mode',
    }
  }
  const sb = requireSupabase()
  const { data: sess } = await sb.auth.getSession()
  const res = await fetch(functionsUrl('payhero-provision'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
      apikey: config.supabaseAnonKey,
    },
    body: JSON.stringify({ shortCode }),
  })
  const body = await res.json().catch(() => ({}))
  const result = body as Partial<PayHeroProvisioningResult>

  // A 422 is a normal outcome — PayHero refused that Till — and it carries a
  // message written for the ISP, so it is returned rather than thrown. Only a
  // transport or auth failure throws, because those know nothing about the Till
  // the ISP actually typed.
  if (!res.ok && res.status !== 422) {
    throw new PaymentError(
      (body as { error?: string }).error ?? 'The payment channel could not be set up.',
    )
  }
  return {
    ok: Boolean(result.ok),
    status: (result.status ?? 'failed') as PayHeroProvisioningResult['status'],
    channelId: result.channelId ?? null,
    created: Boolean(result.created),
    message: result.message ?? 'Payment channel setup failed.',
    code: result.code ?? null,
  }
}

/**
 * Starts a PayHero STK payment for the caller's own tenant.
 *
 * The amount is NOT a parameter and must never become one: it is resolved
 * server-side from the tenant's plan or invoice row, which is what makes it
 * impossible for a browser to choose what it pays.
 */
export async function startPayHeroPayment(input: {
  phone: string
  invoiceId?: string | null
  clientId?: string | null
  planId?: string | null
}): Promise<{ ok: boolean; reference: string; promptSent: boolean; message: string }> {
  const sb = requireSupabase()
  const { data: sess } = await sb.auth.getSession()
  const res = await fetch(functionsUrl('payhero-stk'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sess.session?.access_token ?? ''}`,
      apikey: config.supabaseAnonKey,
    },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new PaymentError(
      (body as { error?: string }).error ?? 'The payment could not be started.',
      (body as { code?: string }).code ?? null,
    )
  }
  return body as { ok: boolean; reference: string; promptSent: boolean; message: string }
}