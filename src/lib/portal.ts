/**
 * Browser-facing API for the public captive portal at /portal/:slug.
 *
 * The customer using this module is not signed in and cannot be: the router
 * redirected them here precisely because they have no connectivity. So every
 * call here is anonymous, and every call takes the portal slug and nothing
 * else.
 *
 * The rule this module exists to enforce: the browser NEVER sends an amount, an
 * ISP id, or a HashBack AccountID. It names a package and a phone number, and
 * the server decides who gets paid and how much. `startPortalPayment` therefore
 * takes no price argument, and there is no parameter through which one could be
 * smuggled in.
 */
import { IS_LIVE, config } from './config'
import { functionsUrl, requireSupabase } from './supabase'

export class PortalError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}

/** Everything the portal renders that the ISP configures. */
export interface PortalSettings {
  is_enabled: boolean
  portal_name: string | null
  welcome_message: string | null
  terms_conditions: string | null
  support_email: string | null
  support_phone: string | null
  support_whatsapp: string | null
  logo_url: string | null
  background_url: string | null
  background_color: string | null
  primary_color: string | null
  accent_color: string | null
  login_method: 'voucher' | 'customer' | 'both'
  show_packages: boolean
  payment_instructions: string | null
  footer_text: string | null
  social_links: Record<string, string>
  hide_routeros: boolean
  isp_name: string
  isp_slug: string
  brand_color: string
  contact_email: string
  contact_phone: string | null
  // Storefront
  header_text: string | null
  connect_button_text: string
  already_paid_text: string
  packages_heading: string
  popular_label: string
  currency_label: string
  featured_plan_id: string | null
  show_voucher: boolean
  show_login: boolean
  show_reconnect: boolean
  show_contact: boolean
  show_social: boolean
  show_quick_links: boolean
  show_mac: boolean
  quick_links: Record<string, string>
}

/**
 * A package as the portal shows it.
 *
 * `is_featured` and the ordering are decided by the database, not here. The
 * browser cannot badge a package the ISP did not badge, because it is not the
 * browser's decision to make.
 */
export interface PortalPackage {
  id: string
  name: string
  kind: string
  duration_label: string | null
  duration_hours: number | null
  price: number
  speed_down: string | null
  speed_up: string | null
  data_limit: string | null
  fup: string | null
  description: string | null
  is_popular: boolean
  is_featured: boolean
}

export async function fetchPortalSettings(slug: string): Promise<PortalSettings | null> {
  if (!IS_LIVE) return null
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('public_portal_settings', { p_slug: slug })
  if (error) throw new PortalError(error.message)
  return (data as PortalSettings | null) ?? null
}

export async function fetchPortalPackages(slug: string): Promise<PortalPackage[]> {
  if (!IS_LIVE) return []
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('public_portal_packages', { p_slug: slug })
  if (error) throw new PortalError(error.message)
  return (data ?? []) as PortalPackage[]
}

/**
 * Activates a voucher.
 *
 * Scoped to this portal's tenant server-side, so a code belonging to another
 * ISP is rejected here exactly as it would be anywhere else.
 */
export async function redeemPortalVoucher(
  slug: string,
  code: string,
  phone: string,
): Promise<{ success: boolean; message: string }> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('portal_redeem_voucher', {
    p_slug: slug,
    p_code: code.trim(),
    p_phone: phone.trim() || null,
  })
  if (error) throw new PortalError(error.message)
  return data as { success: boolean; message: string }
}

/**
 * Starts a payment for a package.
 *
 * Deliberately has no amount, ISP or account parameter. The price, the
 * destination AND the collection mode are all resolved server-side from the
 * slug and the plan id.
 *
 * The response is one of two shapes depending on how that ISP collects money:
 *  - `mode: 'stk'`        an M-Pesa prompt was sent; poll for settlement.
 *  - `mode: 'manual_till'` nothing was prompted; the customer pays the Till and
 *                         staff confirm it. `instructions` says what to do.
 */
export interface PortalPaymentStart {
  ok: boolean
  status: string
  mode?: 'stk' | 'manual_till'
  message: string
  reference: string
  amount: number
  currency: string
  plan: string
  till_number?: string | null
  paybill_number?: string | null
  notice?: string | null
  instructions?: string[]
}

export async function startPortalPayment(input: {
  slug: string
  planId: string
  phone: string
}): Promise<PortalPaymentStart> {
  const res = await fetch(functionsUrl('portal-stk'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey },
    body: JSON.stringify({
      slug: input.slug,
      planId: input.planId,
      phone: input.phone,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new PortalError(
      (body as { error?: string }).error ?? 'Could not start the payment.',
      (body as { code?: string }).code ?? null,
    )
  }
  return body as PortalPaymentStart
}

/** Polls one payment. Reports settlement; never settles anything itself. */
export async function fetchPortalPaymentStatus(
  slug: string,
  reference: string,
): Promise<{ found: boolean; status?: string; message?: string; plan?: string; amount?: number }> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('portal_payment_status', {
    p_slug: slug,
    p_reference: reference,
  })
  if (error) throw new PortalError(error.message)
  return (data as { found: boolean }) ?? { found: false }
}

/** Existing-customer sign-in, checked against the tenant's own accounts. */
export async function loginPortalCustomer(
  slug: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; message: string; username?: string; expires_at?: string | null }> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('portal_customer_login', {
    p_slug: slug,
    p_username: username.trim(),
    p_password: password,
  })
  if (error) throw new PortalError(error.message)
  return data as { ok: boolean; message: string }
}

/** Recovery for a customer who lost connectivity and does not want to pay. */
export async function reconnectPortalCustomer(
  slug: string,
  username: string,
): Promise<{ ok: boolean; message: string; action?: string }> {
  const sb = requireSupabase()
  const { data, error } = await sb.rpc('portal_reconnect', {
    p_slug: slug,
    p_username: username.trim(),
  })
  if (error) throw new PortalError(error.message)
  return data as { ok: boolean; message: string }
}
