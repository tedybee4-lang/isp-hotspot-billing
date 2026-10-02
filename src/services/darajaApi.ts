/**
 * Daraja compatibility shim — DEPRECATED.
 *
 * This used to wrap the `stk-push` Edge Function. Daraja is no longer the
 * active payment path: that endpoint is deprecated and now returns 410 Gone, and
 * live payments go through `hashback-stk`.
 *
 * Retained so an older import does not break the build. It delegates to the
 * same `initiateStkPush` the rest of the app now uses, which routes to HashBack.
 *
 * New code should call `initiateStkPush` from `lib/data` directly, or
 * `startHashBackPayment` from `lib/payments` when the pending-state contract
 * matters.
 */

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
