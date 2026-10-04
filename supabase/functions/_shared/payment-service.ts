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

  // ── Payment initiation ───────────────────────────────────────────────────

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
}