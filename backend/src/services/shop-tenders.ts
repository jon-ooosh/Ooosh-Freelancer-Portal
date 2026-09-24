/**
 * The till's payment methods, as the BACKEND knows them.
 *
 * The sitter till (freelancer portal) is a separate app, so it takes its list
 * and labels from here via the till context rather than keeping a third copy.
 * The staff till's copy is `frontend/src/lib/shopTenders.ts` — keep the two
 * lists identical (jon, Sep 2026: sitters mirror the staff options for now).
 *
 * ⚠️ The Worldpay terminal (Worldpay + AmEx) is being replaced by a Stripe
 * terminal. When it goes, update BOTH lists — and `COUNTER_REFUND_TENDERS` in
 * shop-sales.ts — together.
 */
export interface ShopTender {
  key: string;
  label: string;
  /** Only once the sale is on a band's job — the weekly shop job can't be billed. */
  needsJob?: boolean;
}

export const SHOP_TENDERS: ShopTender[] = [
  { key: 'worldpay', label: 'Card (Worldpay)' },
  { key: 'amex', label: 'Card (AmEx)' },
  { key: 'till_cash', label: 'Cash' },
  { key: 'stripe_gbp', label: 'Stripe' },
  { key: 'paypal', label: 'PayPal' },
  { key: 'wise_bacs', label: 'Bank transfer' },
  { key: 'invoice_later', label: 'Put it on their bill', needsJob: true },
];

export function tenderLabel(key: string | null | undefined): string {
  return SHOP_TENDERS.find((t) => t.key === key)?.label ?? (key ? key.replace(/_/g, ' ') : 'Unknown');
}
