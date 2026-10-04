// =============================================================================
//  Provider — the single source of truth for which M-Pesa provider is active.
//
//  WHY THIS FILE EXISTS
//  --------------------
//  Several screens need to know "who collects the money?". Left to their own
//  devices they would each hard-code an answer, and the day the provider changes
//  they would disagree with each other and with the backend. A captive portal that
//  says one thing and an admin screen that says another is worse than either being
//  merely stale.
//
//  So there is exactly ONE place that translates a backend value into a label, and
//  every screen imports from here.
//
//  THE ONE RULE
//  ------------
//  This module NEVER decides who is active. It only describes what the backend
//  reported. `portal_create_payment` and `payment_config_status` already decide the
//  provider per tenant; duplicating that decision in the browser would let the UI
//  and the database disagree, and the database always wins when money moves.
//
//  There is deliberately no function here that can construct a PayHero call. The
//  browser talks to ISPFLOW, never to PayHero.
// =============================================================================

/**
 * A payment provider as the backend named it.
 *
 * `manual` is a real, supported mode and is NOT deprecated: it means staff confirm
 * a Till payment by hand. It is simply not the automated path.
 */
export type PaymentProvider = 'payhero' | 'hashback' | 'manual' | 'unknown'

/** How a tenant's money reaches it. */
export type CollectionMode = 'stk' | 'manual_till'

/**
 * What each provider is called in the UI, and whether it is automated.
 *
 * `automated` is what the screens branch on: an automated provider prompts M-Pesa
 * and settles from a verified result, a manual one hands back instructions and
 * waits for a human.
 */
const PROVIDER_INFO: Record<PaymentProvider, { label: string; automated: boolean }> = {
  payhero: { label: 'PayHero', automated: true },
  hashback: { label: 'HashBack', automated: true },
  manual: { label: 'Manual Till / Paybill', automated: false },
  unknown: { label: 'Not configured', automated: false },
}

/**
 * Normalises whatever the backend sent into a known provider.
 *
 * Unknown values become 'unknown' rather than silently defaulting to manual:
 * defaulting would show a customer "pay this Till" instructions for a tenant that
 * is actually configured for automated STK, which looks like the payment path is
 * broken and sends them to the wrong place to pay.
 */
export function toPaymentProvider(value: string | null | undefined): PaymentProvider {
  const v = (value ?? '').toString().trim().toLowerCase()
  if (v === 'payhero') return 'payhero'
  if (v === 'hashback') return 'hashback'
  if (v === 'manual' || v === 'manual_till') return 'manual'
  return 'unknown'
}

/** The name to show a customer. */
export function providerLabel(value: string | null | undefined): string {
  return PROVIDER_INFO[toPaymentProvider(value)].label
}

/**
 * True when this provider sends an M-Pesa prompt on its own.
 *
 * The payment screens use this to decide between a live STK flow and the manual
 * instruction sheet. It is a property of the provider, not a per-screen decision,
 * which is exactly why it lives here rather than in three components.
 */
export function isAutomatedProvider(value: string | null | undefined): boolean {
  return PROVIDER_INFO[toPaymentProvider(value)].automated
}

/**
 * The customer-facing collection mode.
 *
 * Derived from the provider rather than trusted from the wire, because the mode is
 * implied by the provider: an automated provider always prompts, a manual one
 * never does. When the backend sends no mode at all, this is what the screen uses
 * instead of assuming 'stk'.
 */
export function collectionModeFor(
  provider: string | null | undefined,
  reportedMode?: string | null,
): CollectionMode {
  // An explicit, recognised mode from the backend wins: it knows about tenants
  // this helper does not.
  const m = (reportedMode ?? '').trim().toLowerCase()
  if (m === 'manual_till' || m === 'manual') return 'manual_till'
  if (m === 'stk') return 'stk'
  return isAutomatedProvider(provider) ? 'stk' : 'manual_till'
}

// ─────────────────────────────────────────────────────────────────────────────
//  Customer-facing payment states.
//
//  These mirror the backend's own outcome vocabulary so a screen can never invent
//  a state the server cannot report. The most important property is the one the
//  enum name forces: STK_SENT is NOT a success. It means a prompt was sent and
//  nobody has paid anything yet.
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentPhase =
  /** Nothing started. */
  | 'idle'
  /** Asking the server to send the prompt. */
  | 'initiating'
  /** The prompt was accepted. No money has moved. */
  | 'stk_sent'
  /** Waiting for the customer to complete the payment on their phone. */
  | 'awaiting'
  /** Asking the server to confirm with the provider. */
  | 'verifying'
  /** Provider-confirmed. The only state that may claim the money arrived. */
  | 'success'
  | 'failed'
  /** Still in flight at the provider. Not a failure. */
  | 'pending'
  /** We stopped waiting without an answer. Not a failure either. */
  | 'timeout'
  /** Could not reach the provider at all. */
  | 'provider_unavailable'

/** Phases after which nothing further should be attempted. */
const TERMINAL: ReadonlySet<PaymentPhase> = new Set<PaymentPhase>([
  'success',
  'failed',
  'timeout',
])

/**
 * True when the flow is finished and polling must stop.
 *
 * `pending` is deliberately NOT terminal: the provider can still settle a payment
 * minutes later, so continuing to poll is correct. `timeout` IS terminal, because
 * continuing to poll forever would just burn the customer's battery and data on a
 * page they have probably navigated away from.
 */
export function isTerminalPhase(phase: PaymentPhase): boolean {
  return TERMINAL.has(phase)
}

/**
 * Whether a screen may show "Payment successful".
 *
 * This exists as a named function so that the rule has exactly one enforcement
 * point. A screen that decides this for itself with `status === 'success'` on some
 * locally-assumed value is exactly the bug this prevents: the customer sees a
 * receipt for money that never arrived, and the ISP has no way to reconcile it.
 */
export function canShowSuccess(phase: PaymentPhase): boolean {
  return phase === 'success'
}

/**
 * Maps a backend payment status onto a phase.
 *
 * Only 'success' maps to success, because only the backend may say so. Every other
 * value is deliberately conservative: an unrecognised status becomes 'pending',
 * never a guess at either outcome.
 */
export function phaseFromStatus(
  status: string | null | undefined,
  opts: { timedOut?: boolean } = {},
): PaymentPhase {
  if (opts.timedOut) return 'timeout'
  const s = (status ?? '').toString().trim().toLowerCase()
  if (s === 'success' || s === 'settled' || s === 'completed') return 'success'
  if (s === 'failed' || s === 'reversed' || s === 'cancelled') return 'failed'
  // 'pending', '', null and anything unrecognised are all still in flight. A new
  // provider state must not be mistaken for a failure or, worse, a success.
  return 'pending'
}

/**
 * Customer-safe copy for a phase.
 *
 * Deliberately free of provider vocabulary, HTTP status codes and any internal
 * detail: these strings are shown to a customer who is standing at a router with
 * no connectivity, and "provider returned 502" helps nobody.
 */
export function phaseMessage(phase: PaymentPhase): string {
  switch (phase) {
    case 'idle':
      return 'Choose a package to get started.'
    case 'initiating':
      return 'Sending the M-Pesa prompt…'
    case 'stk_sent':
      return 'Check your phone for the M-Pesa prompt.'
    case 'awaiting':
      return 'Enter your M-Pesa PIN on your phone to complete the payment.'
    case 'verifying':
      return 'Confirming your payment…'
    case 'success':
      return 'Payment successful. Your package has been activated.'
    case 'failed':
      return 'Payment was not completed.'
    case 'pending':
      return 'Your payment is still being confirmed.'
    case 'timeout':
      return 'We could not confirm your payment yet. Please check your payment status again.'
    case 'provider_unavailable':
      return 'Payments are temporarily unavailable. Please try again later.'
  }
}