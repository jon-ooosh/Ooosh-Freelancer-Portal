/**
 * The till's payment methods — ONE list, used by the till and the week's
 * takings, so a label can't read one way at the counter and another in the
 * report.
 */
/** Tender keys map to HireHop bank accounts via getHHBankId() on the backend. */
export const TENDERS: { key: string; label: string; needsJob?: boolean }[] = [
  { key: 'worldpay', label: 'Card (Worldpay)' },
  { key: 'amex', label: 'Card (AmEx)' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'stripe_gbp', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'wise_bacs', label: 'Bank transfer' },
  { key: 'invoice_later', label: 'Put it on their bill', needsJob: true },
];

/** Human label for a tender key. */
export function tenderLabel(key: string | null | undefined): string {
  return TENDERS.find(t => t.key === key)?.label ?? (key ? key.replace(/_/g, ' ') : 'Unknown');
}
