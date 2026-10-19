/**
 * Which methods may record NEW money (jon, 19 Oct 2026 — STRIPE-TERMINAL-SPEC §15).
 *
 * The card reader is THE card payment now. Worldpay, Amex, PayPal and Lloyds stay for
 * an admin only — jon's backup terminal and the odd historical case. Stripe (Online) too
 * (jon, 19 Oct): portal payments record themselves, so typing one in is only ever the
 * admin's recovery for a payment that failed to record. REFUNDS are not
 * affected (refund / reimburse routes don't call this), so historical excesses can
 * still go back the way they came.
 *
 * Mirrors `frontend/src/lib/paymentMethods.ts` (which hides them) — change both.
 * Only the STAFF routes check this: the portal, the Wise matcher and other automation
 * record what actually arrived.
 */
export const ADMIN_ONLY_PAYMENT_METHODS = ['stripe_gbp', 'worldpay', 'amex', 'paypal', 'lloyds_bank'];

export function newPaymentMethodAllowed(method: string | null | undefined, role: string | null | undefined): boolean {
  return role === 'admin' || !ADMIN_ONLY_PAYMENT_METHODS.includes(String(method || ''));
}

/** The refusal staff see, naming what to use instead. */
export const ADMIN_ONLY_METHOD_MESSAGE =
  'Stripe (Online), Worldpay, Amex, PayPal and Lloyds are admin only now. Use the card reader, Wise (Bank Transfer) or Till (Cash).';
