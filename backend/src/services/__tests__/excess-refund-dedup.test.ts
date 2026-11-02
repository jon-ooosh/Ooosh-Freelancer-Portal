/**
 * Refund-leg dedup — the rule that stops one refund being counted twice.
 *
 * Job 15187 (Sep 2026): OP reimbursed £900 of a £2,100 excess via the Stripe
 * API. Stripe's charge.refunded webhook came back 290ms later, found no leg
 * carrying that refund id (the endpoint didn't write one until 2s later, after
 * it had answered the browser) and applied the same £900 again — £1,800
 * reimbursed against a £900 refund the client had an email for. 30-odd other
 * records carried the same duplicate legs; two of them ended up with
 * reimbursement_amount at exactly 2 × excess_amount_taken.
 *
 * Two things had to be true for that to happen, and both are covered here:
 * the leg is claimed by the reimburse endpoint the moment the Stripe refund
 * exists (tested in the endpoint), and dedup matches on the refund id ALONE —
 * never on which path told us about it.
 */

import { isDuplicateLeg, RefundLeg } from '../excess-refund';

const REF = 'stripe_refund_re_3Tzh3uHCmwVA1ByM1DLWvaCE';

describe('isDuplicateLeg', () => {
  it('recognises OP\'s own refund when Stripe reports it back under a different source', () => {
    // The exact 15187 shape: the reimburse endpoint claimed the leg as
    // `manual`; charge.refunded arrives as `stripe_webhook` for the same id.
    const claimed: RefundLeg[] = [{ source: 'manual', ref: REF, amount: 900 }];
    expect(isDuplicateLeg(claimed, REF)).toBe(true);
  });

  it('recognises it whichever path got there first', () => {
    const webhookFirst: RefundLeg[] = [{ source: 'stripe_webhook', ref: REF, amount: 900 }];
    expect(isDuplicateLeg(webhookFirst, REF)).toBe(true);
  });

  it('lets a genuinely different refund through', () => {
    const legs: RefundLeg[] = [{ source: 'manual', ref: REF, amount: 900 }];
    expect(isDuplicateLeg(legs, 'stripe_refund_re_somethingelse')).toBe(false);
  });

  it('lets the first refund through on an empty ledger', () => {
    expect(isDuplicateLeg([], REF)).toBe(false);
    expect(isDuplicateLeg(null, REF)).toBe(false);
    expect(isDuplicateLeg(undefined, REF)).toBe(false);
  });

  it('never dedups a leg with no ref — the caller owns idempotency there', () => {
    const legs: RefundLeg[] = [{ source: 'hh_reconcile', ref: null, amount: 900 }];
    expect(isDuplicateLeg(legs, null)).toBe(false);
    expect(isDuplicateLeg(legs, undefined)).toBe(false);
  });
});
