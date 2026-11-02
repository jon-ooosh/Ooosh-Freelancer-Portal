/**
 * Which methods may record NEW money (jon, 19 Oct 2026 — STRIPE-TERMINAL-SPEC §15).
 *
 * The card reader is THE card payment now. Worldpay, Amex, PayPal and Lloyds stay for
 * an admin only — jon's backup terminal and the odd historical case — so nobody falls
 * back to the old way out of habit. Stripe (Online) too (jon, 19 Oct): portal payments
 * record themselves, so typing one in is only the admin's recovery for one that didn't. REFUNDS are not affected: every refund / reimburse
 * list keeps every method, so historical excesses can still go back the way they came.
 *
 * Mirrors `backend/src/services/payment-methods.ts`, which enforces it — change both.
 */
export const ADMIN_ONLY_PAYMENT_METHODS = ['stripe_gbp', 'worldpay', 'amex', 'paypal', 'lloyds_bank'];

/** May this role record a NEW payment by this method? */
export function newPaymentMethodAllowed(method: string, role: string | null | undefined): boolean {
  return role === 'admin' || !ADMIN_ONLY_PAYMENT_METHODS.includes(method);
}
