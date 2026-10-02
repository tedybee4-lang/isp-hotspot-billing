// =============================================================================
//  M-Pesa STK Push — browser-side helper
// =============================================================================
//  ⚠️  SECURITY: Daraja consumer key / secret / passkey must NEVER live in
//      client code. They ship in the public JS bundle, so anyone can read them
//      from DevTools and drain your paybill.
//
//  This module holds no credentials. It calls the `stk-push` Supabase Edge
//  Function, which reads the tenant's credentials from Postgres using the
//  service role and performs the Daraja call server-side.
//
//  Implementation: supabase/functions/stk-push/index.ts
// =============================================================================

import { initiateStkPush as initiateStkPushRequest } from '../lib/data'

export interface StkPushResult {
  success: boolean
  message: string
  checkoutRequestId?: string
  merchantRequestId?: string
  environment?: 'sandbox' | 'production'
}

/** Pushes an STK prompt to a customer's M-Pesa app. */
export async function initiateStkPush(request: {
  phoneNumber?: string
  phone?: string
  amount: number
  invoiceId?: string
  clientId?: string
}): Promise<StkPushResult> {
  const phone = request.phoneNumber ?? request.phone ?? ''
  return initiateStkPushRequest({
    phone,
    amount: request.amount,
    invoiceId: request.invoiceId,
    clientId: request.clientId,
  })
}

/** Alias kept for callers that prefer the descriptive name. */
export const sendStkPush = initiateStkPush

/**
 * Status is resolved by the Daraja callback, not by polling from the browser
 * (that would require the consumer secret). Kept as a no-op for compatibility.
 */
export async function queryStkPushStatus(_checkoutRequestId: string): Promise<{
  ResponseCode: string
  ResponseDescription: string
}> {
  return {
    ResponseCode: '0',
    ResponseDescription: 'Status is settled asynchronously by the stk-callback function.',
  }
}

/** Shape returned by Safaricom's async result callback. */
export interface DarajaCallback {
  ResultCode: number
  ResultDesc: string
  CheckoutRequestID?: string
  MpesaReceiptNumber?: string
  TransactionDate?: string
  PhoneNumber?: string
  Amount?: number
}

export const isCallbackSuccessful = (callback: DarajaCallback): boolean =>
  callback.ResultCode === 0

/** Kept for compatibility with the previous export surface. */
export function describeStkError(data: { ResponseDescription?: string }): string {
  return data.ResponseDescription || 'The payment request was rejected.'
}