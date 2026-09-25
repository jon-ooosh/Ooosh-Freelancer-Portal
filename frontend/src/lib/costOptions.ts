/**
 * Shared cost pick-lists.
 *
 * `PAID_NOW_METHODS` lives here rather than inside CostsPage because three
 * surfaces offer the same choice — Mark paid, batch pay, and recording a refund
 * — and "which account did the money move on?" has to mean the same thing in
 * all of them. Each value is also a `xero_bank_<method>` system-settings key,
 * so a list that drifts is a payment posted to the wrong Xero bank account.
 */
export const PAID_NOW_METHODS: { value: string; label: string }[] = [
  { value: 'lloyds_transfer', label: 'Lloyds bank transfer' },
  { value: 'wise', label: 'Wise bank transfer' },
  { value: 'cot_card', label: 'Company card (COT)' },
  { value: 'amex', label: 'Amex card' },
  { value: 'lloyds_cc', label: 'Lloyds credit card' },
  { value: 'petty_cash', label: 'Petty cash' },
  { value: 'paypal', label: 'PayPal' },
];
