/**
 * Browser-facing HashBack and payment APIs.
 *
 * Everything here is a thin call to an Edge Function or a tenant-safe RPC. No
 * credential is ever held, returned or sent by this module — the platform API
 * key and webhook secret live only in the Edge Function environment and the
 * encrypted store.
 *
 * The distinction this file is careful about:
 *
 *   fetchPlatformHashBackStatus  safe for a super-admin screen. Returns
 *                                booleans and provider status.
 *   fetchMyPaymentChannel        safe for an ISP screen. Resolved server-side
 *                                from the caller's own membership; there is
 *                                deliberately no ispId parameter.
 */
import { requireSupabase, functionsUrl } from './supabase'
import { IS_LIVE, config } from './config'

export class PaymentError extends Error {
  /** The RPC or function's machine-readable code, when it gave one. */
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'PaymentError'
    this.code = code
  }
}

/** Non-secret platform connection state. Never contains a key or ciphertext. */
export interface PlatformHashBackStatus {
  connection_status: 'unconfigured' | 'configured' | 'verified' | 'failed'
  has_api_key: boolean
  has_webhook_secret: boolean
  last_verified_at: string | null
  last_error: string | null
  token_balance: number | null
  partner_access: boolean | null
  webhook_url: string | null
  provider_metadata: Record<string, unknown>
}

/** The result of a real verification call against HashBack. */
export interface PlatformVerificationResult {
  apiAvailable: boolean
  partnerAccess: boolean
  tokenBalance: number | null
  linkedChannels: number | null
  lastError: string | null
  /** Set when a capability is genuinely unavailable, so the UI can explain it. */
  detail: string | null
}

/** The caller's own tenant payment channel. */
export interface MyPaymentChannel {
  isp_id: string
  payment_provider: string
  payment_mode: string
  merchant_name: string | null
  channel_type: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline' | null
  till_number: string | null
  paybill_number: string | null
  channel_shortcode: string | null
  /** The tenant's own channel identifier. Safe to display; not a credential. */
  hashback_account_id: string | null
  connection_status: 'not_configured' | 'pending' | 'connected' | 'failed' | 'disabled'
  last_verified_at: string | null
  last_error: string | null
  provider_status: string | null
  customer_notice: string | null
  has_channel_secret: boolean
  updated_at: string
}

async function callAdmin(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = requireSupabase()
  const { data: sess } = await sb.auth.getSession()
  const res = await fetch(functionsUrl('hashback-admin'), {
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

/** Reads platform connection status. Never returns a secret. */
export async function fetchPlatformHashBackStatus(): Promise<PlatformHashBackStatus | null> {
  if (!IS_LIVE) return null
  const body = await callAdmin({ action: 'status' })
  return (body.status as PlatformHashBackStatus) ?? null
}

/**
 * Stores the platform credentials.
 *
 * The secret is posted once, over TLS, to an Edge Function that encrypts it
 * before writing. It is never placed in localStorage, never logged, and never
 * returned — the response carries only booleans.
 */
export async function savePlatformHashBackCredentials(input: {
  apiKey?: string
  webhookSecret?: string
  webhookUrl?: string
}): Promise<PlatformHashBackStatus | null> {
  const body = await callAdmin({ action: 'save', ...input })
  return (body.status as PlatformHashBackStatus) ?? null
}

/**
 * Performs a real verification call against HashBack.
 *
 * Every field it reports was confirmed by the provider. Partner access is
 * reported false when the partner endpoint refuses the key — it is never
 * inferred.
 */
export async function verifyPlatformHashBack(): Promise<PlatformVerificationResult> {
  const body = await callAdmin({ action: 'verify' })
  return {
    apiAvailable: Boolean(body.apiAvailable),
    partnerAccess: Boolean(body.partnerAccess),
    tokenBalance: typeof body.tokenBalance === 'number' ? body.tokenBalance : null,
    linkedChannels: typeof body.linkedChannels === 'number' ? body.linkedChannels : null,
    lastError: (body.lastError as string | null) ?? null,
    detail: (body.detail as string | null) ?? null,
  }
}

/**
 * The caller's own payment channel.
 *
 * No ispId parameter exists by design: the tenant is resolved server-side from
 * the authenticated profile, so a request cannot be pointed at another ISP.
 */
export async function fetchMyPaymentChannel(): Promise<MyPaymentChannel | null> {
  if (!IS_LIVE) return null
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('my_payment_channel')
  if (error) throw new PaymentError(error.message, error.code ?? null)
  return (data as MyPaymentChannel | null) ?? null
}

/** Saves the tenant's merchant name, channel type and shortcode. */
export async function saveMyPaymentChannel(input: {
  merchantName: string
  channelType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
  shortcode: string
  paybillNumber?: string
  tillNumber?: string
}): Promise<MyPaymentChannel | null> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('save_isp_channel', {
    p_merchant_name: input.merchantName,
    p_channel_type: input.channelType,
    p_shortcode: input.shortcode,
    p_paybill_number: input.paybillNumber ?? null,
    p_till_number: input.tillNumber ?? null,
  })
  if (error) throw new PaymentError(error.message, error.code ?? null)
  return (data as MyPaymentChannel | null) ?? null
}

/**
 * Starts a payment for an invoice or a package.
 *
 * The caller names WHAT is being paid for; the server calculates the amount from
 * the tenant's own plan or invoice row. There is deliberately no `amount`
 * parameter — accepting one would let a browser ask to be charged a different
 * figure than the package costs.
 */
export async function startHashBackPayment(input: {
  phone: string
  invoiceId?: string
  planId?: string
  clientId?: string
}): Promise<{
  ok: boolean
  /** Always 'pending'. Never 'success'. */
  status: string
  message: string
  paymentId: string
  reference: string
  amount: number
  currency: string
  checkoutRequestId: string | null
}> {
  const sb = requireSupabase()
  const { data: sess } = await sb.auth.getSession()
  const res = await fetch(functionsUrl('hashback-stk'), {
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
      (body as { error?: string }).error ?? 'Could not start the payment.',
      (body as { code?: string }).code ?? null,
    )
  }
  return body as never
}

/**
 * Reconciliation items waiting for a human.
 *
 * Returns the caller's own queue for a tenant, and the whole platform's for a
 * super admin. Resolved server-side; there is no tenant parameter.
 */
export async function fetchReconciliationQueue(): Promise<Array<{
  id: string
  provider: string
  provider_reference: string | null
  provider_transaction_id: string | null
  amount: number | null
  reason: string
  status: string
  created_at: string
}>> {
  if (!IS_LIVE) return []
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('my_reconciliation_queue', { limit_rows: 50 })
  if (error) throw new PaymentError(error.message)
  return (data ?? []) as never
}