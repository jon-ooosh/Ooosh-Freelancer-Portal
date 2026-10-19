/**
 * The till's payment methods — ONE list, used by the till and the week's
 * takings, so a label can't read one way at the counter and another in the
 * report.
 */
/** Tender keys map to HireHop bank accounts via getHHBankId() on the backend. */
export const TENDERS: { key: string; label: string; needsJob?: boolean }[] = [
  // Only offered when the card reader is switched on for this login (ShopTillPage).
  { key: 'card_reader', label: 'Card reader' },
  { key: 'stripe_gbp', label: 'Stripe' },
  { key: 'wise_bacs', label: 'Bank transfer' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'invoice_later', label: 'Put it on their bill', needsJob: true },
  // Admin only for new sales (STRIPE-TERMINAL-SPEC §15, lib/paymentMethods.ts) —
  // kept here so old sales and the week's takings still read their label.
  { key: 'worldpay', label: 'Card (Worldpay)' },
  { key: 'amex', label: 'Card (AmEx)' },
  { key: 'paypal', label: 'PayPal' },
];

/** Human label for a tender key. */
export function tenderLabel(key: string | null | undefined): string {
  return TENDERS.find(t => t.key === key)?.label ?? (key ? key.replace(/_/g, ' ') : 'Unknown');
}
