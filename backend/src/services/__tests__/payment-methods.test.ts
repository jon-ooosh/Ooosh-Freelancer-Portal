import { newPaymentMethodAllowed, ADMIN_ONLY_PAYMENT_METHODS } from '../payment-methods';
import { SHOP_TENDERS, SITTER_TENDER_KEYS, sitterTendersFor } from '../shop-tenders';

describe('newPaymentMethodAllowed (STRIPE-TERMINAL-SPEC §15)', () => {
  it('keeps Worldpay, Amex, PayPal and Lloyds for admins only', () => {
    for (const m of ADMIN_ONLY_PAYMENT_METHODS) {
      expect(newPaymentMethodAllowed(m, 'admin')).toBe(true);
      for (const role of ['manager', 'weekend_manager', 'staff', 'general_assistant', 'freelancer', undefined]) {
        expect(newPaymentMethodAllowed(m, role)).toBe(false);
      }
    }
  });

  it('lets everyone use the card reader, Stripe, Wise and cash', () => {
    for (const m of ['card_reader', 'stripe_gbp', 'wise_bacs', 'till_cash', 'invoice_later', 'rolled_over']) {
      expect(newPaymentMethodAllowed(m, 'staff')).toBe(true);
    }
  });
});

describe('sitter till tenders', () => {
  it('offers the card reader first, then cash', () => {
    expect(sitterTendersFor(true).map((t) => t.key)).toEqual(['card_reader', 'till_cash', 'invoice_later']);
    expect(sitterTendersFor(false).map((t) => t.key)).toEqual(['till_cash', 'invoice_later']);
  });
  it('every sitter key is a real tender', () => {
    for (const k of SITTER_TENDER_KEYS) expect(SHOP_TENDERS.some((t) => t.key === k)).toBe(true);
  });
});
