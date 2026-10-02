// =============================================================================
//  M-Pesa STK Callback — Supabase Edge Function (Deno)
// =============================================================================
//  Safaricom POSTs the payment result here. We mark the payment successful,
//  settle the linked invoice, and reactivate the customer's service.
//
//  Deploy:  supabase functions deploy stk-callback --no-verify-jwt
//  IMPORTANT: Safaricom requires an HTTPS, publicly reachable URL.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

/** Pull a value out of Safaricom's CallbackMetadata array */
function meta(items: Array<{ Name: string; Value: string | number }>, name: string) {
  return items?.find((i) => i.Name === name)?.Value
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const payload = await req.json()
    const cb = payload?.Body?.stkCallback

    if (!cb) {
      return new Response('Bad payload', { status: 400 })
    }

    const resultCode = Number(cb.ResultCode)
    const checkoutId = cb.CheckoutRequestID
    const metadata = cb.CallbackMetadata?.Item ?? []
    const receipt = meta(metadata, 'MpesaReceiptNumber')
    const amount = Number(meta(metadata, 'Amount') ?? 0)

    console.log(`M-Pesa callback ${checkoutId}: code=${resultCode} amount=${amount}`)

    // Resolve the pending payment created by stk-push
    const { data: payment } = await admin
      .from('payments')
      .select('*')
      .eq('checkout_request_id', checkoutId)
      .maybeSingle()

    if (!payment) {
      console.warn(`No pending payment found for ${checkoutId}`)
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const succeeded = resultCode === 0

    await admin
      .from('payments')
      .update({
        status: succeeded ? 'success' : 'failed',
        mpesa_receipt: receipt ? String(receipt) : null,
      })
      .eq('id', payment.id)

    if (!succeeded) {
      console.log(`Payment failed: ${cb.ResultDesc}`)
      return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Settle the invoice
    if (payment.invoice_id) {
      await admin
        .from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', payment.invoice_id)

      // Extend the customer's subscription window
      const { data: invoice } = await admin
        .from('invoices')
        .select('client_id, plan_name')
        .eq('id', payment.invoice_id)
        .maybeSingle()

      if (invoice?.client_id) {
        const { data: client } = await admin
          .from('clients')
          .select('expires_at')
          .eq('id', invoice.client_id)
          .maybeSingle()

        const from = client?.expires_at && new Date(client.expires_at) > new Date()
          ? new Date(client.expires_at)
          : new Date()

        await admin
          .from('clients')
          .update({
            status: 'active',
            balance: 0,
            plan_name: invoice.plan_name ?? undefined,
            expires_at: new Date(from.getTime() + 30 * 864e5).toISOString(),
          })
          .eq('id', invoice.client_id)
      }
    }

    // Audit trail
    await admin.from('audit_logs').insert({
      actor_email: 'mpesa-callback',
      isp_id: payment.isp_id,
      action: 'payment:success',
      target_type: 'payment',
      target_id: payment.id,
      metadata: { amount, receipt: receipt ?? null },
    })

    // Safaricom only needs a 200 acknowledgement
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('stk-callback error:', err)
    return new Response(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})