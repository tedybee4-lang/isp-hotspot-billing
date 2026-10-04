// =============================================================================
//  Payment gateway service.
//
//  The business layer between billing and the HashBack adapter. It owns every
//  decision the adapter deliberately does not: who the tenant is, what the
//  customer may pay, how much it is, whether this event has already been
//  applied, and whether anything downstream should be activated.
//
//  Division of responsibility, which is the point of the two layers:
//
//    hashback.ts   speaks HashBack. Knows endpoints and field names. Does NOT
//                  know what an ISP or an invoice is.
//    this module   speaks the business. Knows tenants, money and state. Does NOT
//                  know HTTP, endpoints or provider field names.
//
//  Four rules this module enforces so no caller can bypass them:
//
//    1. The tenant comes from the authenticated session, never from a parameter.
//       There is no `ispId` argument on any public method here.
//    2. The amount comes from resolve_chargeable(), which reads the plan or
//       invoice inside the tenant's own data. A caller can name a package; it
//       cannot name a price.
//    3. Initiation never settles. Every success path requires a provider-
//       verified result.
//    4. Applying a provider result is idempotent, at the database level and
//       again here, so a duplicate webhook cannot renew twice.
// =============================================================================

import {
  HashBackClient,
  normaliseMsisdn,
} from './hashback.ts'
import { PayHeroClient } from './payhero.ts'
import {
  readSettlementFields,
  isSuccessfulPayment,
  type HashBackWebhookPayload,
} from './hashback-webhook.ts'
import {
  resolvePlatformCredentials,
  recordVerificationResult,
  type AdminClient,
} from './hashback-credentials.ts'
import { resolvePayHeroCredentials } from './payhero-credentials.ts'

/** What a caller is told after asking for a prompt. Never means "paid". */
export interface StartPaymentResult {
  ok: boolean
  paymentId: string
  reference: string
  amount: number
  currency: string
  /** Text to show the payer. */
  message: string
  /** True once a prompt was actually accepted by the provider. */
  promptSent: boolean
  checkoutId: string | null
  merchantRequestId: string | null
}

/** Result of processing one provider event. */
export interface ProcessResult {
  ok: boolean
  /** False when the event was already applied and nothing changed. */
  settled: boolean
  duplicate: boolean
  activated: boolean
  /** Why nothing happened, when nothing did. */
  reason?: string
  ispId?: string
}

/**
 * The outcome of one automatic channel-provisioning attempt.
 *
 * `status` mirrors the internal channel states the system already uses. READY is
 * only ever returned when PayHero actually returned a channel id AND the database
 * accepted the binding; nothing else can produce it.
 */
export interface PayHeroProvisioningResult {
  ok: boolean
  status: 'pending' | 'ready' | 'failed'
  /** PayHero's channel id, once one exists. Null on failure. */
  channelId: number | null
  /** True only when this call created a NEW channel at PayHero. */
  created: boolean
  /** Safe, customer-facing sentence. Never contains a credential or provider text. */
  message: string
  code?: string
}

/** Errors this service raises, as opposed to provider errors. */
export class PaymentServiceError extends Error {
  readonly code:
    | 'unauthorized'
    | 'not_configured'
    | 'not_connected'
    | 'invalid_phone'
    | 'unknown_reference'
    | 'unknown_account'
    | 'conflict'
    | 'provider_unavailable'

  constructor(
    code: PaymentServiceError['code'],
    message: string,
    /** True when retrying the same request could plausibly succeed. */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'PaymentServiceError'
    this.code = code
  }
}

/** Narrow an unknown thrown value. */
export function isPaymentServiceError(err: unknown): err is PaymentServiceError {
  return err instanceof PaymentServiceError
}

export class PaymentGatewayService {
  private readonly admin: AdminClient
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: { admin: AdminClient; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.admin = opts.admin
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = opts.timeoutMs ?? 20_000
  }

  /**
   * Builds a client from the stored platform credential.
   *
   * Throws rather than returning null, because every caller needs a credential
   * to proceed and a silent null would surface later as a confusing provider
   * error that looks like a HashBack outage.
   */
  private async client(): Promise<HashBackClient> {
    const creds = await resolvePlatformCredentials(this.admin)
    if (!creds) {
      throw new PaymentServiceError(
        'not_configured',
        'The platform has not configured HashBack credentials yet.',
      )
    }
    return new HashBackClient({
      apiKey: creds.apiKey,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })
  }

  /**
   * Builds a PayHero client from the stored platform credential.
   *
   * Same contract as client(): throws rather than returning null, so an absent
   * credential surfaces as a clear "not configured" rather than as a confusing
   * 401 from PayHero that looks like a provider outage.
   */
  private async payHeroClient(): Promise<PayHeroClient> {
    const creds = await resolvePayHeroCredentials(this.admin)
    return new PayHeroClient({
      apiToken: creds.apiToken,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    })
  }

  /**
   * Resolves the authenticated caller's ISP from their own profile row.
   *
   * This is the same resolution the RLS policies use, so the service cannot act
   * on a different tenant than the database itself would permit. There is no
   * parameter through which a caller could suggest one.
   */
  private async requireTenant(jwt: string): Promise<string> {
    const { data: userData, error: userErr } = await this.admin.auth.getUser(jwt)
    // An invalid or expired session is an authentication failure, NOT a
    // misconfiguration. Reporting it as `not_configured` made it surface as
    // HTTP 503, so an expired login was indistinguishable from the platform
    // being broken: the caller retried forever instead of re-authenticating.
    if (userErr || !userData?.user) {
      throw new PaymentServiceError('unauthorized', 'Invalid or expired session.')
    }

    const { data: profile, error: profileErr } = await this.admin
      .from('profiles')
      .select('isp_id')
      .eq('id', userData.user.id)
      .maybeSingle()

    if (profileErr) {
      throw new PaymentServiceError('not_configured', 'Could not read your account.')
    }

    const ispId = (profile as { isp_id?: string | null } | null)?.isp_id
    if (!ispId) {
      throw new PaymentServiceError(
        'not_configured',
        'Your account is not linked to an ISP. Ask the platform administrator to set it up.',
      )
    }
    return ispId
  }

  /**
   * Loads this tenant's payment channel.
   *
   * Scoped by the resolved ISP. The AccountID comes from here and nowhere else,
   * which is what makes "the browser chooses the account id" impossible.
   */
  private async loadChannel(ispId: string): Promise<{
    accountId: string
    connected: boolean
  }> {
    const { data, error } = await this.admin
      .from('isp_payment_configs')
      .select('payment_provider, hashback_account_id, connection_status')
      .eq('isp_id', ispId)
      .maybeSingle()

    if (error) {
      throw new PaymentServiceError('not_configured', 'Could not read payment settings.')
    }

    const cfg = data as {
      payment_provider?: string | null
      hashback_account_id?: string | null
      connection_status?: string | null
    } | null

    if (cfg?.payment_provider !== 'hashback') {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP is not set up for HashBack payments.',
      )
    }
    if (!cfg.hashback_account_id) {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP has no HashBack payment channel yet. Connect one in Payment Settings.',
      )
    }

    return {
      accountId: cfg.hashback_account_id,
      connected: cfg.connection_status === 'connected',
    }
  }

  /**
   * Loads this tenant's PayHero payment channel.
   *
   * Scoped by the resolved ISP, and the channel id comes from here and nowhere
   * else — which is what makes "the browser chooses the channel" impossible.
   * Mirrors loadChannel() for HashBack so both providers enforce the same rule.
   */
  private async loadPayHeroChannel(ispId: string): Promise<{
    channelId: number
    connected: boolean
  }> {
    const { data, error } = await this.admin
      .from('isp_payment_configs')
      .select('payment_provider, payhero_channel_id, connection_status')
      .eq('isp_id', ispId)
      .maybeSingle()

    if (error) {
      throw new PaymentServiceError('not_configured', 'Could not read payment settings.')
    }

    const cfg = data as {
      payment_provider?: string | null
      payhero_channel_id?: number | null
      connection_status?: string | null
    } | null

    if (cfg?.payment_provider !== 'payhero') {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP is not set up for PayHero payments.',
      )
    }
    if (cfg.payhero_channel_id == null) {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP has no PayHero payment channel yet. Select one in Payment Settings.',
      )
    }

    return {
      channelId: Number(cfg.payhero_channel_id),
      connected: cfg.connection_status === 'connected',
    }
  }

  /**
   * Starts a PayHero STK payment for an invoice or a package.
   *
   * This is the PayHero counterpart of startPayment(), and it upholds exactly the
   * same four rules:
   *
   *   1. The tenant comes from the authenticated session, never a parameter.
   *   2. The amount comes from create_payhero_payment(), which resolves it inside
   *      the tenant's own plan or invoice row. The caller names a package; it
   *      cannot name a price. Nothing here accepts an amount from the request.
   *   3. Initiation never settles. The payment stays PENDING and the customer
   *      stays unactivated until a PayHero-verified result arrives.
   *   4. The provider reference is stored, so a callback or a later verification
   *      can find this exact payment.
   */
  async startPayHeroPayment(
    jwt: string,
    input: {
      phone: string
      invoiceId?: string | null
      clientId?: string | null
      planId?: string | null
      /** Our own callback endpoint. Optional; PayHero honours it per request. */
      callbackUrl?: string | null
    },
  ): Promise<StartPaymentResult> {
    // Authenticate BEFORE validating input, so every unauthenticated request
    // fails identically with 401 and the endpoint's internals stay unmapped to
    // anyone holding the public anon key.
    const ispId = await this.requireTenant(jwt)

    const msisdn = normaliseMsisdn(input.phone)
    if (!msisdn) {
      throw new PaymentServiceError(
        'invalid_phone',
        'Enter a valid Kenyan phone number, for example 0712345678.',
      )
    }

    const channel = await this.loadPayHeroChannel(ispId)
    if (!channel.connected) {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP payment channel is not connected yet.',
      )
    }
    // The database creates the pending row and mints the reference in one
    // transaction, which is what makes the reference unique and guaranteed to
    // resolve to exactly one payment.
    const { data: created, error: createErr } = await this.admin.rpc('create_payhero_payment', {
      p_invoice_id: input.invoiceId ?? null,
      p_client_id: input.clientId ?? null,
      p_plan_id: input.planId ?? null,
      p_msisdn: msisdn,
    })

    if (createErr) {
      throw new PaymentServiceError('conflict', createErr.message)
    }

    const row = created as {
      payment_id: string
      reference: string
      amount: number
      currency: string
      payhero_channel_id: number
    }

    // A second guard on the channel: it came from the database, but confirm it
    // matches what we resolved, so a race on the config cannot send this tenant's
    // payment through another's Till.
    if (Number(row.payhero_channel_id) !== channel.channelId) {
      throw new PaymentServiceError(
        'unknown_account',
        'The payment channel changed while this payment was starting. Try again.',
      )
    }

    const client = await this.payHeroClient()
    const init = await client.initiateStk({
      channelId: channel.channelId,
      // The authoritative amount, straight from the plan or invoice.
      amount: Number(row.amount),
      phoneNumber: msisdn,
      externalReference: row.reference,
      callbackUrl: input.callbackUrl ?? undefined,
    })

    if (!init.accepted || !init.reference) {
      // The provider refused the prompt. The payment row stays pending with a
      // reason so an operator can see what happened; it is not marked failed
      // because the money may still be promptable later.
      await this.admin
        .from('payments')
        .update({ failure_reason: init.message })
        .eq('id', row.payment_id)

      return {
        ok: false,
        paymentId: row.payment_id,
        reference: row.reference,
        amount: Number(row.amount),
        currency: row.currency ?? 'KES',
        message: init.message,
        promptSent: false,
        checkoutId: null,
        merchantRequestId: null,
      }
    }

    // Store the provider's transaction reference. Still pending — explicitly.
    await this.admin.rpc('record_payhero_stk', {
      p_payment_id: row.payment_id,
      p_transaction_id: init.reference,
    })

    return {
      ok: true,
      paymentId: row.payment_id,
      reference: row.reference,
      amount: Number(row.amount),
      currency: row.currency ?? 'KES',
      message: init.message,
      promptSent: true,
      // PayHero's transaction id is returned as the checkout id so callers that
      // already persist that field keep working unchanged.
      checkoutId: init.reference,
      merchantRequestId: null,
    }
  }

  // ── HashBack payment initiation ──────────────────────────────────────────

  /**
   * Starts a payment for an invoice or a package.
   *
   * The caller names WHAT is being paid for, never how much. The amount is
   * resolved inside resolve_chargeable() from the tenant's own plan or invoice
   * row, so a tampered request cannot turn a KSh 1,500 package into a KSh 1
   * payment.
   *
   * On success the payment exists and is PENDING. It is not settled, the
   * customer is not activated, and no confirmation SMS has been sent. Those all
   * wait for a verified provider result.
   */
  async startPayment(
    jwt: string,
    input: {
      phone: string
      invoiceId?: string | null
      clientId?: string | null
      planId?: string | null
    },
  ): Promise<StartPaymentResult> {
    // Authenticate BEFORE validating input.
    //
    // The order matters: with validation first, an unauthenticated caller got
    // a differentiated 400 ("enter a valid Kenyan phone number") and an
    // authenticated one got something else, which maps the endpoint's internals
    // for anyone holding the public anon key. Resolving the tenant first means
    // every unauthenticated request fails identically with 401.
    const ispId = await this.requireTenant(jwt)

    const msisdn = normaliseMsisdn(input.phone)
    if (!msisdn) {
      throw new PaymentServiceError(
        'invalid_phone',
        'Enter a valid Kenyan phone number, for example 0712345678.',
      )
    }

    const channel = await this.loadChannel(ispId)

    if (!channel.connected) {
      throw new PaymentServiceError(
        'not_connected',
        'This ISP payment channel is not connected yet.',
      )
    }

    // The database creates the pending row and mints the reference. Doing it in
    // one transaction is what makes the reference unique and guaranteed to
    // resolve to exactly one payment.
    const { data: created, error: createErr } = await this.admin.rpc(
      'create_hashback_payment',
      {
        p_invoice_id: input.invoiceId ?? null,
        p_client_id: input.clientId ?? null,
        p_plan_id: input.planId ?? null,
        p_msisdn: msisdn,
      },
    )

    if (createErr) {
      throw new PaymentServiceError('conflict', createErr.message)
    }

    const row = created as {
      payment_id: string
      reference: string
      amount: number
      currency: string
      hashback_account_id: string
    }

    // A second guard on the AccountID: it came from the database, but confirm it
    // matches the channel we resolved, so a race on the config cannot send this
    // tenant's payment through another's channel.
    if (row.hashback_account_id !== channel.accountId) {
      throw new PaymentServiceError(
        'unknown_account',
        'The payment channel changed while this payment was starting. Try again.',
      )
    }

    const client = await this.client()
    const init = await client.initiateStk({
      accountId: channel.accountId,
      // The authoritative amount, straight from the plan or invoice.
      amount: Number(row.amount),
      msisdn,
      reference: row.reference,
    })

    if (!init.accepted) {
      // The provider refused the prompt. The payment row stays pending with a
      // reason, so an operator can see what happened; it is not marked failed
      // because the money may still be promptable later.
      await this.admin.from('payments').update({
        failure_reason: init.message,
      }).eq('id', row.payment_id)

      return {
        ok: false,
        paymentId: row.payment_id,
        reference: row.reference,
        amount: Number(row.amount),
        currency: row.currency ?? 'KES',
        message: init.message,
        promptSent: false,
        checkoutId: init.checkoutId,
        merchantRequestId: init.merchantRequestId,
      }
    }

    // Stamp the provider identifiers. Still pending — explicitly.
    await this.admin.rpc('record_hashback_checkout', {
      p_payment_id: row.payment_id,
      p_checkout_id: init.checkoutId,
      p_merchant_request_id: init.merchantRequestId,
    })

    return {
      ok: true,
      paymentId: row.payment_id,
      reference: row.reference,
      amount: Number(row.amount),
      currency: row.currency ?? 'KES',
      message: init.message,
      promptSent: true,
      checkoutId: init.checkoutId,
      merchantRequestId: init.merchantRequestId,
    }
  }

  // ── PayHero verification and settlement ───────────────────────────────────

  /**
   * Verifies a PayHero transaction with the provider and settles it if confirmed.
   *
   * This is the ONLY path that can settle a PayHero payment, and the ordering is
   * the whole security argument:
   *
   *   1. Ask PayHero what actually happened (`/api/v2/transaction-status`).
   *   2. Settle ONLY if PayHero says success.
   *
   * An inbound callback is explicitly NOT trusted. PayHero documents no webhook
   * signature — no HMAC, no shared secret, nothing to verify a callback against —
   * so a callback body is an unauthenticated assertion from the internet. This
   * method ignores whatever the caller claims the status was and re-reads the
   * truth from PayHero over the credentialed channel. A forged "paid" callback
   * therefore activates nothing, because it is never believed.
   *
   * Idempotency comes from the shared settlement function: a second call for a
   * reference already settled returns duplicate=true and writes nothing, so
   * out-of-order or repeated callbacks cannot renew a customer twice.
   */
  async verifyPayHeroPayment(input: {
    reference: string
    /**
     * Optional provider identifiers supplied by the callback. These are LOOKUP
     * HINTS and nothing more: they choose which question to ask PayHero, and are
     * never a reason to settle. They exist because PayHero indexes a transaction
     * under its own identifiers, and the M-Pesa receipt usually resolves faster
     * than the reference we originally sent.
     */
    receiptHint?: string | null
    checkoutRequestIdHint?: string | null
  }): Promise<ProcessResult> {
    const reference = input.reference?.trim()
    if (!reference) {
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'unknown_reference',
      }
    }

    // Only columns that actually exist on `payments` may be selected.
    //
    // `payhero_channel_id` lives on isp_payment_configs, NOT here. Naming a column
    // that does not exist makes the query ERROR, and because the result was
    // destructured without checking, the error surfaced as a null row and every
    // real payment was reported `unknown_reference`. That is what stopped the
    // verified customer payment from ever reaching settlement.
    const { data: payment, error: paymentErr } = await this.admin
      .from('payments')
      .select('id, isp_id, status, provider_transaction_id, amount')
      .eq('provider_reference', reference)
      .maybeSingle()

    if (paymentErr) {
      // A read failure is NOT an unknown reference. Treating the two alike is what
      // let a real payment be quietly written off for reconciliation.
      throw new PaymentServiceError('conflict', paymentErr.message)
    }

    const row = payment as {
      id?: string
      isp_id?: string | null
      status?: string | null
      provider_transaction_id?: string | null
      amount?: number | string | null
    } | null

    if (!row?.isp_id) {
      await this.recordPayHeroReconciliation(reference, 'no matching payment for this reference')
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'unknown_reference',
      }
    }

    // Already settled: stop here. Re-asking PayHero would spend a call to learn
    // something already known, and settle_payhero_payment would return a duplicate.
    if (row.status === 'success') {
      return {
        ok: true, settled: false, duplicate: true, activated: false, ispId: row.isp_id,
      }
    }

    const client = await this.payHeroClient()

    // Look the transaction up by an identifier PAYHERO issued.
    //
    // Verified against the live API after a real customer payment got stuck at
    // 'pending' forever:
    //
    //   GET /api/v2/transaction-status?reference=ISPFLOW-<ours>  -> 404
    //   GET /api/v2/transaction-status?reference=feb7-4ad8-...   -> SUCCESS
    //
    // PayHero resolves this query by its own identifiers, and it documents that the
    // M-Pesa code is accepted too. So rather than picking one value and hoping,
    // the candidates are tried in order of how likely each is to be indexed:
    //
    //   1. provider_transaction_id  the reference PayHero returned when it accepted
    //                                the STK push (record_payhero_stk stored it)
    //   2. the callback's M-Pesa receipt        (a hint, never a decision)
    //   3. the callback's CheckoutRequestID     (ditto)
    //   4. our own reference                    (last resort)
    //
    // A candidate that 404s is not an error: it means "not indexed under that name
    // yet", so the next candidate is tried rather than abandoning the payment.
    const candidates = [
      row.provider_transaction_id,
      input.receiptHint,
      input.checkoutRequestIdHint,
      reference,
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)

    // De-duplicated while preserving order, so a repeated value costs one call.
    const lookups = [...new Set(candidates.map((v) => v.trim()))]

    let status: Awaited<ReturnType<typeof client.getTransactionStatus>> | null = null
    let lastError: unknown = null

    for (const lookup of lookups) {
      try {
        status = await client.getTransactionStatus(lookup)
        break
      } catch (err) {
        // A 404 means PayHero has no record under that reference yet. For a
        // transaction only just prompted that is the normal race: the callback can
        // arrive before the provider has indexed it. It is not an error that
        // abandons the payment — which is what left a paying customer stuck — so
        // the next candidate is tried.
        const e = err as { status?: number | null }
        if (e?.status === 404) {
          lastError = err
          continue
        }
        throw err
      }
    }

    if (!status) {
      // Every identifier we hold is unknown to PayHero. That is either very early
      // indexing latency or a reference that will never resolve, so the payment is
      // left PENDING for the reconciliation sweep to retry, not failed: it is not
      // known to be unpaid, and failing it could cancel a real payment.
      console.warn(
        'payhero-callback: no PayHero record under any known identifier',
        JSON.stringify({ reference: row.id, tried: lookups.length }),
      )
      return {
        ok: true, settled: false, duplicate: false, activated: false,
        reason: 'pending', ispId: row.isp_id,
      }
    }

    if (status.state === 'pending') {
      // Genuinely still in flight. Nothing is written and nothing is activated; a
      // later callback or a scheduled sweep will try again.
      return {
        ok: true, settled: false, duplicate: false, activated: false,
        reason: 'pending', ispId: row.isp_id,
      }
    }

    if (status.state === 'failed') {
      await this.admin.rpc('fail_hashback_payment', {
        p_reference: reference,
        p_reason: 'PayHero reported the transaction as failed',
      })
      return {
        ok: true, settled: false, duplicate: false, activated: false,
        reason: 'failed', ispId: row.isp_id,
      }
    }

    // ── Amount verification ─────────────────────────────────────────────────
    //
    // A verified SUCCESS is necessary but not sufficient: it must be the SUCCESS of
    // THIS payment. If PayHero reports a different amount than the plan charged, the
    // customer has paid the wrong sum for this package, and activating it silently
    // would be both a revenue and a trust failure.
    //
    // The comparison is only made when PayHero actually reported an amount. An
    // absent amount is not a mismatch; inventing a zero here would reject every
    // legitimate payment whose status response omits it.
    if (status.amount !== null && row.amount !== null && row.amount !== undefined) {
      const expected = Number(row.amount)
      if (Number.isFinite(expected) && Math.abs(expected - status.amount) > 0.009) {
        // Recorded for a human, and NOT settled. This is the one case where a
        // confirmed provider success is deliberately left unapplied.
        console.error(
          'payhero-callback: amount mismatch, refusing to settle',
          JSON.stringify({
            reference: row.id,
            expected,
            reported: status.amount,
          }),
        )
        await this.recordPayHeroReconciliation(
          reference,
          `amount mismatch: expected ${expected}, PayHero reported ${status.amount}`,
        )
        return {
          ok: false, settled: false, duplicate: false, activated: false,
          reason: 'amount_mismatch', ispId: row.isp_id,
        }
      }
    }

    // ── Verified success ────────────────────────────────────────────────────
    //
    // Only now, and only because PayHero said so on a credentialed call, is the
    // payment settled. Everything downstream (invoice, package activation, RADIUS,
    // SMS) happens inside settle_hashback_payment, in one transaction, guarded
    // against replays.
    const { data: settled, error } = await this.admin.rpc('settle_payhero_payment', {
      p_reference: reference,
      // Prefer the reference PayHero reports about the transaction, then the
      // M-Pesa code. Falling back to OUR reference would store our own id as if
      // it were the provider's, which is what made receipts unreadable.
      p_transaction_id: status.providerReference ?? status.receipt ?? reference,
      p_receipt: status.receipt ?? status.providerReference ?? reference,
      p_msisdn: status.phone,
      // The provider's amount, so the settlement record carries what PayHero
      // actually moved rather than what we asked for.
      p_amount: status.amount,
      // No channel id is passed: `payments` has no such column, and the provider's
      // verbatim payload below already records which merchant took the money. This
      // argument is only an audit label in the shared settle function.
      p_channel_id: null,
      // PayHero's own words, kept verbatim so a disputed payment can be audited.
      p_provider_metadata: status.raw as Record<string, unknown>,
    })

    if (error) {
      throw new PaymentServiceError('conflict', error.message)
    }

    const result = settled as {
      settled?: boolean
      duplicate?: boolean
      activated?: boolean
      reason?: string
      isp_id?: string
    } | null

    return {
      ok: result?.reason === undefined,
      settled: result?.settled ?? false,
      duplicate: result?.duplicate ?? false,
      activated: result?.activated ?? false,
      reason: result?.reason,
      ispId: result?.isp_id ?? row.isp_id,
    }
  }

  /**
   * Queues an unmatched PayHero event for a human.
   *
   * Failures here are swallowed on purpose: a reconciliation write failing must
   * not become a 500 that makes PayHero retry the same callback forever.
   */
  private async recordPayHeroReconciliation(reference: string, reason: string): Promise<void> {
    try {
      await this.admin.from('payment_reconciliation').insert({
        provider: 'payhero',
        provider_reference: reference,
        reason,
        status: 'unmatched',
      })
    } catch {
      // Nothing further to escalate to from here.
    }
  }

  // ── Provider event processing ────────────────────────────────────────────

  /**
   * Resolves a HashBack AccountID to its tenant.
   *
   * Routing is by AccountID, never by phone number or client-supplied ISP id.
   * An AccountID that matches nothing is refused rather than guessed at, because
   * guessing would credit one tenant with another tenant's money.
   */
  private async resolveAccount(accountId: string | null): Promise<{
    ispId: string
  } | null> {
    if (!accountId) return null

    const { data } = await this.admin
      .from('isp_payment_configs')
      .select('isp_id')
      .eq('hashback_account_id', accountId)
      .maybeSingle()

    const row = data as { isp_id?: string | null } | null
    return row?.isp_id ? { ispId: row.isp_id } : null
  }

  /**
   * Applies one provider event.
   *
   * Signature verification is the caller's responsibility and has already
   * happened: a method that accepted an unverified payload would be dangerous to
   * reuse from anywhere else.
   *
   * The decision tree:
   *   success event  → settle (idempotently), which activates exactly once
   *   failure event  → mark failed, never activate
   *   anything else  → record for reconciliation, activate nothing
   *
   * A duplicate returns settled:false and changes nothing, so the provider's
   * retry does not renew twice.
   */
  async processWebhookEvent(payload: HashBackWebhookPayload): Promise<ProcessResult> {
    const fields = readSettlementFields(payload)

    // An AccountID we do not recognise must not be applied to any tenant.
    const routed = await this.resolveAccount(fields.accountId)
    if (!routed) {
      await this.recordReconciliation(fields, 'unknown AccountID; no tenant owns it')
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'unknown_account',
      }
    }

    // A reference we cannot resolve activates nothing. It is queued for a human
    // rather than guessed at.
    if (!fields.reference) {
      await this.recordReconciliation(fields, 'webhook carried no payment reference')
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'unknown_reference', ispId: routed.ispId,
      }
    }

    if (isSuccessfulPayment(payload)) {
      const { data } = await this.admin.rpc('settle_hashback_payment', {
        p_reference: fields.reference,
        p_transaction_id: fields.transactionId,
        p_receipt: fields.receipt,
        p_checkout_id: fields.checkoutId,
        p_merchant_request_id: fields.merchantRequestId,
        p_msisdn: fields.msisdn,
        p_amount: fields.amount,
        p_account_id: fields.accountId,
        // The provider payload verbatim, so a disputed payment can be audited
        // against exactly what HashBack said.
        p_provider_metadata: payload as unknown as Record<string, unknown>,
      })

      const settled = data as {
        settled?: boolean
        duplicate?: boolean
        activated?: boolean
        reason?: string
        isp_id?: string
      } | null

      return {
        ok: settled?.reason === undefined,
        settled: settled?.settled ?? false,
        duplicate: settled?.duplicate ?? false,
        activated: settled?.activated ?? false,
        reason: settled?.reason,
        ispId: settled?.isp_id ?? routed.ispId,
      }
    }

    // A non-success event. Record it as failed so the customer sees the truth,
    // but never activate and never renew.
    await this.admin.rpc('fail_hashback_payment', {
      p_reference: fields.reference,
      p_reason: String(payload.ResponseDescription ?? 'provider reported a non-success event'),
      p_transaction_id: fields.transactionId,
    })

    return {
      ok: true, settled: false, duplicate: false, activated: false,
      ispId: routed.ispId,
    }
  }

  /**
   * Queues an unapplicable event for a human.
   *
   * Failures here are swallowed on purpose: a reconciliation write failing must
   * not become a 500 that makes the provider retry the same event forever.
   */
  private async recordReconciliation(
    fields: ReturnType<typeof readSettlementFields>,
    reason: string,
  ): Promise<void> {
    try {
      await this.admin.from('payment_reconciliation').insert({
        provider: 'hashback',
        provider_reference: fields.reference,
        provider_transaction_id: fields.transactionId,
        amount: fields.amount,
        msisdn: fields.msisdn,
        reason,
        status: 'unmatched',
      })
    } catch {
      // Nothing further to escalate to from here.
    }
  }

  // ── Reconciliation ───────────────────────────────────────────────────────

  /**
   * Reconciles one pending payment against the provider.
   *
   * The adapter established that /transactionstatus returns an acknowledgement
   * and can stay pending indefinitely, so it is NOT used to decide settlement.
   * PULL is the reliable path: it returns the provider's own record of the
   * transfer, which can be matched and settled.
   *
   * Settlement still goes through the same idempotent settle function the
   * webhook uses, so reconciling a payment that already settled is a no-op
   * rather than a second renewal.
   */
  async reconcilePayment(input: {
    reference: string
    transactionId: string
  }): Promise<ProcessResult> {
    const { data: payment } = await this.admin
      .from('payments')
      .select('isp_id, status')
      .eq('provider_reference', input.reference)
      .maybeSingle()

    const row = payment as { isp_id?: string | null; status?: string | null } | null

    if (!row?.isp_id) {
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'unknown_reference',
      }
    }

    // Already settled: nothing to reconcile. Returning before calling PULL
    // avoids spending a token to learn something already known.
    if (row.status === 'success') {
      return {
        ok: true, settled: false, duplicate: true, activated: false,
        ispId: row.isp_id,
      }
    }

    const channel = await this.loadChannel(row.isp_id)
    const client = await this.client()
    const pulled = await client.pullTransaction({
      accountId: channel.accountId,
      transactionId: input.transactionId,
    })

    if (!pulled.found) {
      return {
        ok: false, settled: false, duplicate: false, activated: false,
        reason: 'provider has no record of this transaction', ispId: row.isp_id,
      }
    }

    const { data: settled, error } = await this.admin.rpc('settle_hashback_payment', {
      p_reference: input.reference,
      p_transaction_id: pulled.transactionId ?? input.transactionId,
      p_receipt: pulled.transactionId ?? null,
      p_amount: pulled.amount,
      p_account_id: channel.accountId,
      p_provider_metadata: pulled.raw as Record<string, unknown>,
    })

    if (error) {
      throw new PaymentServiceError('conflict', error.message)
    }

    const result = settled as {
      settled?: boolean
      duplicate?: boolean
      activated?: boolean
      isp_id?: string
    } | null

    return {
      ok: true,
      settled: result?.settled ?? false,
      duplicate: result?.duplicate ?? false,
      activated: result?.activated ?? false,
      ispId: result?.isp_id ?? row.isp_id,
    }
  }

  // ── Platform and channel administration ──────────────────────────────────

  /**
   * Verifies the platform connection with real API calls.
   *
   * Every field returned is something HashBack actually confirmed. Partner
   * access in particular is reported false when the partner endpoint refuses the
   * key, because pretending it works would send an ISP into a channel
   * provisioning flow that cannot succeed.
   */
  async verifyPlatformConnection(): Promise<{
    apiAvailable: boolean
    partnerAccess: boolean
    tokenBalance: number | null
    linkedChannels: number | null
    lastError: string | null
    detail: string | null
  }> {
    const client = await this.client()

    // /credits/balance is the cheapest real call and spends no token.
    let tokenBalance: number | null = null
    let apiAvailable = false
    let lastError: string | null = null
    try {
      const balance = await client.getBalance()
      apiAvailable = true
      tokenBalance = balance.balance
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'could not reach HashBack'
    }

    // Partner access is reported only if the partner endpoint actually answers.
    let partnerAccess = false
    let linkedChannels: number | null = null
    if (apiAvailable) {
      try {
        const accounts = await client.listLinkedAccounts()
        partnerAccess = true
        linkedChannels = accounts.count
      } catch (err) {
        // A refusal here is the honest answer: this key cannot provision
        // channels, so the admin UI must say so rather than offer the option.
        lastError = err instanceof Error ? err.message : lastError
      }
    }

    await recordVerificationResult(this.admin, {
      connectionStatus: apiAvailable ? 'verified' : 'failed',
      lastError,
      tokenBalance,
      partnerAccess,
      providerMetadata: { linkedChannels },
    })

    return {
      apiAvailable,
      partnerAccess,
      tokenBalance,
      linkedChannels,
      lastError,
      detail: partnerAccess
        ? null
        : 'Partner API access is unavailable with this key, so channels cannot be '
          + 'provisioned automatically.',
    }
  }

  /**
   * Links or refreshes an ISP's HashBack channel.
   *
   * Idempotent at the application layer, which the adapter cannot be: the docs
   * state that re-linking a shortcode returns a *fresh* account_id, so a repeated
   * call would leave the ISP with two channels for one Till. An existing channel
   * is therefore always checked first.
   */
  async linkISPChannel(input: {
    ispId: string
    merchantName: string
    channelType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
    shortcode: string
    accountNo?: string | null
    callbackUrl?: string | null
  }): Promise<{ linked: boolean; accountId: string | null; detail: string }> {
    // Reuse a channel that already points at this shortcode, whoever owns it.
    const { data: existing } = await this.admin.rpc('find_channel_by_shortcode', {
      p_shortcode: input.shortcode,
      p_channel_type: input.channelType,
    })

    const found = existing as {
      found?: boolean
      account_id?: string | null
      isp_id?: string | null
    } | null

    if (found?.found && found.account_id) {
      if (found.isp_id !== input.ispId) {
        // Someone else already owns this shortcode. Refusing is the only safe
        // answer; creating a second channel would split one Till's history.
        return {
          linked: false,
          accountId: null,
          detail: 'That Till or PayBill is already linked to another ISP on this platform.',
        }
      }
      return {
        linked: true,
        accountId: found.account_id,
        detail: 'That channel is already linked. Reused the existing account.',
      }
    }

    const client = await this.client()
    const result = await client.linkAccount({
      accountName: input.merchantName,
      accountType: input.channelType,
      paybillNo: input.channelType === 'CustomerPayBillOnline' ? input.shortcode : undefined,
      tillNo: input.channelType === 'CustomerBuyGoodsOnline' ? input.shortcode : undefined,
      accountNo: input.accountNo ?? undefined,
      callbackWebhook: input.callbackUrl ?? undefined,
    })

    await this.admin.rpc('record_channel_link', {
      p_isp_id: input.ispId,
      p_account_id: result.accountId,
      // Connected only when HashBack actually returned an account id.
      p_status: result.accountId ? 'connected' : 'failed',
      p_error: result.accountId ? null : result.message,
      p_provider_status: result.status,
    })

    return {
      linked: result.linked && result.accountId !== null,
      accountId: result.accountId,
      detail: result.accountId
        ? 'Channel linked and verified with HashBack.'
        : result.message,
    }
  }

  /** Reports a tenant's channel state. Used by the ISP settings screen. */
  async getISPChannelStatus(ispId: string): Promise<{
    accountId: string
    connected: boolean
  }> {
    const channel = await this.loadChannel(ispId)
    return { accountId: channel.accountId, connected: channel.connected }
  }

  // ── Automatic PayHero channel provisioning ──────────────────────────────

  /**
   * Registers (or reuses) a PayHero payment channel for an ISP's Till.
   *
   * This is what lets a new ISP accept money without a human creating the channel
   * in PayHero's dashboard first.
   *
   * IDEMPOTENCY IS THE WHOLE PROBLEM HERE
   * ------------------------------------
   * PayHero's "Register Payment Channel" is a plain POST with no idempotency key,
   * so calling it twice creates two channels for one Till and splits that Till's
   * history in half. The order below is therefore not incidental:
   *
   *   1. If this ISP already holds a channel for the SAME short code, reuse it and
   *      return. Saving unchanged settings creates nothing.
   *   2. If another ISP already holds that short code, refuse. Two tenants sharing
   *      a Till would each settle against the other's money.
   *   3. Adopt a channel PayHero already knows for that short code, rather than
   *      duplicating one that was registered out-of-band.
   *   4. Only then register a new one.
   *
   * Every failure leaves the channel NOT ready, with a safe message. Nothing here
   * marks a channel ready on the strength of a call that did not succeed.
   */
  async provisionPayHeroChannel(input: {
    ispId: string
    /** The Till or PayBill number the ISP entered. */
    shortCode: string
    /** Beneficiary/bank account number PayHero records alongside the channel. */
    accountNumber?: string | null
    /** Channel description shown to the ISP. Defaults to the ISP's own name. */
    description?: string | null
  }): Promise<PayHeroProvisioningResult> {
    const shortCode = (input.shortCode ?? '').replace(/\D/g, '')
    const ispId = input.ispId

    // ── Server-side Till validation, before PayHero is contacted ──────────
    // Deliberately permissive on length. Kenyan Tills are commonly 6 digits and
    // PayBills 5, but this platform already has a live 7-digit Till in production
    // (Beta Broadband, 5441898), and a check that rejected it would silently break
    // an ISP whose payments work today. So the guard rejects only what is
    // certainly wrong — non-digits, or something too short or long to be a Till.
    // PayHero remains the authority on whether the number actually exists.
    if (!/^\d{5,9}$/.test(shortCode)) {
      return this.failProvisioning(
        ispId,
        'Enter a valid Till or PayBill number.',
        'invalid_till',
      )
    }

    const { data: cfg } = await this.admin
      .from('isp_payment_configs')
      .select('payhero_channel_id, payhero_channel_short_code, merchant_name')
      .eq('isp_id', ispId)
      .maybeSingle()

    const config = cfg as {
      payhero_channel_id?: number | null
      payhero_channel_short_code?: string | null
      merchant_name?: string | null
    } | null

    // ── 1. Unchanged Till → reuse, create nothing ─────────────────────────
    // The stored short code is what makes this check possible; without it every
    // settings save would have to ask PayHero again and could create a duplicate.
    const storedShortCode = (config?.payhero_channel_short_code ?? '').replace(/\D/g, '')
    if (config?.payhero_channel_id && storedShortCode === shortCode) {
      return {
        ok: true,
        status: 'ready',
        channelId: Number(config.payhero_channel_id),
        created: false,
        message: 'Your Till is already connected to PayHero.',
      }
    }

    // ── 2. Does another ISP already own this Till? ────────────────────────
    // One Till collecting for two ISPs silently sends one customer's money to
    // another's revenue, so this is refused rather than allowed to "work".
    const { data: claimants } = await this.admin
      .from('isp_payment_configs')
      .select('isp_id, payhero_channel_short_code')
      .neq('isp_id', ispId)
      .not('payhero_channel_short_code', 'is', null)

    const clash = ((claimants ?? []) as Array<{
      isp_id: string
      payhero_channel_short_code: string | null
    }>).find(
      (r) => (r.payhero_channel_short_code ?? '').replace(/\D/g, '') === shortCode,
    )
    if (clash) {
      return this.failProvisioning(
        ispId,
        'That Till is already connected to another ISP on this platform.',
        'till_in_use',
      )
    }

    const client = await this.payHeroClient()

    // ── 3. Adopt a channel PayHero already knows about ────────────────────
    const discovered = await client.findChannelByShortCode(shortCode).catch(() => null)
    if (discovered) {
      const assigned = await this.assignPayHeroChannel(ispId, discovered.id, shortCode)
      if (!assigned.ok) return assigned
      return {
        ok: true,
        status: 'ready',
        channelId: discovered.id,
        created: false,
        message: 'Connected to your existing PayHero Till.',
      }
    }

    return this.registerNewPayHeroChannel({ ispId, shortCode, input, config })
  }

  /** Steps 4-5 of provisioning: create the channel at PayHero, then bind it. */
  private async registerNewPayHeroChannel(args: {
    ispId: string
    shortCode: string
    input: { accountNumber?: string | null; description?: string | null }
    config: { merchant_name?: string | null } | null
  }): Promise<PayHeroProvisioningResult> {
    const { ispId, shortCode, input, config } = args

    // PayHero's Register Payment Channel requires the account id. Read from the
    // last verified snapshot rather than spending another provider call.
    const accountId = await this.payHeroAccountId()
    if (accountId === null) {
      return this.failProvisioning(
        ispId,
        'PayHero account details are not available yet. Please try again shortly.',
        'account_unavailable',
      )
    }

    let registered: Awaited<ReturnType<PayHeroClient['registerChannel']>>
    try {
      registered = await (await this.payHeroClient()).registerChannel({
        channelType: 'till',
        accountId,
        shortCode,
        // PayHero requires this field. The short code is the truthful value when
        // the ISP has not supplied a beneficiary account number.
        accountNumber: (input.accountNumber ?? '').trim() || shortCode,
        description:
          (input.description ?? config?.merchant_name ?? '').trim() || `ISP Till ${shortCode}`,
      })
    } catch (err) {
      const diagnostic = err instanceof Error ? err.message : 'PayHero refused the request.'
      // Provider text is kept for an operator but never rendered to a customer,
      // and it can never contain the credential because the client never puts it
      // in a thrown error.
      return this.failProvisioning(
        ispId,
        'Payment channel setup failed. Please verify the Till Number and try again.',
        'registration_failed',
        diagnostic,
      )
    }

    if (!registered.registered || !registered.channel) {
      return this.failProvisioning(
        ispId,
        'PayHero did not create a channel for this Till. Please try again.',
        'registration_failed',
        registered.message,
      )
    }

    const assigned = await this.assignPayHeroChannel(ispId, registered.channel.id, shortCode)
    if (!assigned.ok) return assigned

    return {
      ok: true,
      status: 'ready',
      channelId: registered.channel.id,
      created: true,
      message: 'Payment channel created and ready.',
    }
  }

  /**
   * Records a provisioning failure without ever marking the channel ready.
   *
   * Shaped as a `return this.failProvisioning(...)` helper so no call site can
   * accidentally report success on a failed write.
   */
  private async failProvisioning(
    ispId: string,
    message: string,
    code: string,
    diagnostic?: string,
  ): Promise<PayHeroProvisioningResult> {
    console.error(
      'payhero-provision: failed',
      JSON.stringify({ ispId, code, diagnostic: diagnostic ?? null }),
    )
    // Best effort: the ISP must still receive the failure message even if this
    // bookkeeping write fails, so the result is returned either way.
    try {
      await this.admin.rpc('set_payhero_channel_state', {
        p_isp_id: ispId,
        p_status: 'failed',
        p_error: diagnostic ? `${message} (${diagnostic})` : message,
      })
    } catch {
      // Nothing further to escalate to from here.
    }

    return { ok: false, status: 'failed', channelId: null, created: false, message, code }
  }

  /**
   * Binds a PayHero channel to an ISP and records the short code behind it.
   *
   * The one-channel-one-ISP rule is enforced in the database, so a crafted request
   * cannot point two tenants at one Till even if this code were bypassed.
   */
  private async assignPayHeroChannel(
    ispId: string,
    channelId: number,
    shortCode: string,
  ): Promise<PayHeroProvisioningResult> {
    const { data, error } = await this.admin.rpc('provision_payhero_channel', {
      p_isp_id: ispId,
      p_channel_id: channelId,
      p_short_code: shortCode,
    })

    const result = data as {
      ok?: boolean
      reason?: string
      payhero_channel_id?: number | null
      connection_status?: string | null
    } | null

    if (error || !result?.ok) {
      const reason = result?.reason ?? 'assignment_failed'
      const message =
        reason === 'channel_already_assigned'
          ? 'That PayHero channel is already used by another ISP.'
          : 'The payment channel could not be saved. Please try again.'
      console.error(
        'payhero-provision: assignment refused',
        JSON.stringify({ ispId, channelId, reason, error: error?.message ?? null }),
      )
      return { ok: false, status: 'failed', channelId: null, created: false, message, code: reason }
    }

    return {
      ok: true,
      status: result.connection_status === 'connected' ? 'ready' : 'pending',
      channelId: Number(result.payhero_channel_id ?? channelId),
      created: true,
      message: 'Payment channel ready.',
    }
  }

  /** The PayHero account id, which channel registration requires. */
  private async payHeroAccountId(): Promise<number | null> {
    const { data } = await this.admin
      .from('platform_payment_config')
      .select('payhero_account_id')
      .maybeSingle()

    const id = (data as { payhero_account_id?: number | null } | null)?.payhero_account_id
    return id === null || id === undefined ? null : Number(id)
  }

  /**
   * Reconciles PayHero payments that are still pending.
   *
   * The recovery path for a callback that never arrived, or one that arrived before
   * PayHero had indexed the transaction. It re-asks PayHero about OUR OWN pending
   * payments only, so it can never invent a payment — it can only confirm one that
   * already exists here, against the provider's own record.
   *
   * `olderThanMinutes` is the throttle: a transaction younger than that is left
   * alone so this never races the callback that is about to arrive.
   */
  async reconcilePendingPayHeroPayments(
    input: { olderThanMinutes?: number; limit?: number } = {},
  ): Promise<{ scanned: number; settled: number; failed: number; stillPending: number }> {
    const olderThan = input.olderThanMinutes ?? 5
    const limit = Math.min(input.limit ?? 20, 100)
    const since = new Date(Date.now() - olderThan * 60_000).toISOString()

    const { data } = await this.admin
      .from('payments')
      .select('provider_reference')
      .eq('payment_provider', 'payhero')
      .eq('status', 'pending')
      .not('initiated_at', 'is', null)
      .lte('initiated_at', since)
      .order('initiated_at', { ascending: true })
      .limit(limit)

    const rows = (data ?? []) as Array<{ provider_reference: string | null }>
    const summary = { scanned: 0, settled: 0, failed: 0, stillPending: 0 }

    for (const row of rows) {
      if (!row.provider_reference) continue
      summary.scanned += 1
      try {
        const result = await this.verifyPayHeroPayment({
          reference: row.provider_reference,
        })
        if (result.settled) summary.settled += 1
        else if (result.reason === 'failed') summary.failed += 1
        else summary.stillPending += 1
      } catch {
        // One unreachable transaction must not stop the sweep. The payment stays
        // pending and is retried on the next run.
        summary.stillPending += 1
      }
    }

    console.log('payhero-reconcile: sweep complete', JSON.stringify(summary))
    return summary
  }
}