/**
 * The rules for a staff entry in a van sale's activity log
 * (docs/VEHICLE-SALES-SPEC.md §7): what each kind needs, and that a
 * follow-up can't be set in the past.
 */
import { planActivity, followUpTitle } from '../vehicle-sale-activity';
import { SaleError } from '../vehicle-sales';

const TODAY = '2026-10-01';

function errorOf(fn: () => unknown): SaleError {
  try { fn(); } catch (e) { return e as SaleError; }
  throw new Error('expected a SaleError');
}

describe('planActivity', () => {
  it('a viewing defaults to today and keeps who and what', () => {
    expect(planActivity({ type: 'viewing', who: ' Dave ', text: 'Liked it' }, TODAY)).toEqual({
      type: 'viewing', occurredOn: TODAY, who: 'Dave', text: 'Liked it',
      amount: null, listingSite: null, listingUrl: null, followUp: null,
    });
  });

  it('allows a past date, refuses a future one', () => {
    expect(planActivity({ type: 'note', text: 'x', occurredOn: '2026-09-20' }, TODAY).occurredOn).toBe('2026-09-20');
    expect(errorOf(() => planActivity({ type: 'note', text: 'x', occurredOn: '2026-10-02' }, TODAY)).status).toBe(400);
  });

  it('an offer needs an amount and who made it', () => {
    expect(errorOf(() => planActivity({ type: 'offer', who: 'Dealer' }, TODAY)).message).toMatch(/amount/);
    expect(errorOf(() => planActivity({ type: 'offer', amount: 18000 }, TODAY)).message).toMatch(/Who/);
    expect(planActivity({ type: 'offer', who: 'Dealer', amount: '18000' }, TODAY).amount).toBe(18000);
  });

  it('a listing needs a site; the link must be a web address', () => {
    expect(errorOf(() => planActivity({ type: 'listed' }, TODAY)).status).toBe(400);
    expect(errorOf(() => planActivity({ type: 'listed', listingSite: 'eBay', listingUrl: 'javascript:alert(1)' }, TODAY)).status).toBe(400);
    const a = planActivity({ type: 'listed', listingSite: 'AutoTrader', listingUrl: 'https://autotrader.co.uk/x' }, TODAY);
    expect([a.listingSite, a.listingUrl]).toEqual(['AutoTrader', 'https://autotrader.co.uk/x']);
  });

  it('refuses an empty note and an unknown kind', () => {
    expect(errorOf(() => planActivity({ type: 'note' }, TODAY)).status).toBe(400);
    expect(errorOf(() => planActivity({ type: 'status_change', text: 'x' }, TODAY)).status).toBe(400);
  });

  it('a follow-up must be today or later, for a real person id', () => {
    expect(planActivity({ type: 'contact', who: 'Dave', followUp: { dueDate: TODAY } }, TODAY).followUp)
      .toEqual({ dueDate: TODAY, personId: null });
    expect(errorOf(() => planActivity({ type: 'contact', who: 'Dave', followUp: { dueDate: '2026-09-30' } }, TODAY)).status).toBe(400);
    expect(errorOf(() => planActivity({ type: 'contact', who: 'Dave', followUp: { dueDate: TODAY, personId: 'nope' } }, TODAY)).status).toBe(400);
  });

  it('no follow-up date = no follow-up', () => {
    expect(planActivity({ type: 'contact', who: 'Dave', followUp: { dueDate: '' } }, TODAY).followUp).toBeNull();
  });
});

describe('followUpTitle', () => {
  it('reads on its own in a To Do list', () => {
    expect(followUpTitle('RX21ABC', { type: 'viewing', who: 'Dave', listingSite: null })).toBe('Follow up Dave re RX21ABC sale');
    expect(followUpTitle('RX21ABC', { type: 'listed', who: null, listingSite: 'eBay' })).toBe('Follow up the eBay listing re RX21ABC sale');
    expect(followUpTitle('RX21ABC', { type: 'note', who: null, listingSite: null })).toBe('Follow up the RX21ABC sale');
  });
});
