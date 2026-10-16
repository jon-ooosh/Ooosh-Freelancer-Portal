/**
 * The till's payment methods, as the BACKEND knows them.
 *
 * The sitter till (freelancer portal) is a separate app, so it takes its list
 * and labels from here via the till context rather than keeping a third copy.
 * The staff till's copy is `frontend/src/lib/shopTenders.ts` — keep the two
 * lists identical (jon, Sep 2026: sitters mirror the staff options for now).
 *
 * The Stripe card reader is `card_reader` (STRIPE-TERMINAL-SPEC §14). Worldpay +
 * AmEx are to become admin-only (§15). Any change to the list: update BOTH lists —
 * and `COUNTER_REFUND_TENDERS` in shop-sales.ts — together.
 */
export interface ShopTender {
  key: string;
  label: string;
  /** Only once the sale is on a band's job — the weekly shop job can't be billed. */
  needsJob?: boolean;
}

export const SHOP_TENDERS: ShopTender[] = [
  // The Stripe card reader (STRIPE-TERMINAL-SPEC §14). Only offered when the reader is
  // switched on for the person at the till (shopTendersFor); a sale with it is created
  // by the reader once the card is approved, never by the till's own Save.
  { key: 'card_reader', label: 'Card reader' },
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

/** The tenders to offer — without the card reader unless it is switched on for this person. */
export function shopTendersFor(cardReader: boolean): ShopTender[] {
  return cardReader ? SHOP_TENDERS : SHOP_TENDERS.filter((t) => t.key !== 'card_reader');
}
