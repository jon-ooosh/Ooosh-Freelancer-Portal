/**
 * Credits — the sign rule, and what a refund is allowed to be.
 *
 * Two things here are worth a test rather than a careful reading.
 *
 * THE SIGN. A credit stores negative money so that every existing SUM nets to
 * the true cost without being taught about refunds. That only holds while
 * exactly one function decides the sign — the moment a caller gets to send its
 * own minus, a positive credit gets into the table and the netting silently
 * runs the wrong way (a refund that ADDS to what we spent).
 *
 * THE CEILING. £12.60 of screws can't give back £20, and two £6 refunds can't
 * be followed by a third. Both would leave a purchase reading as negative spend
 * with nothing to flag it.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { applyCreditSign, prepareCreditFromParent, remainingRefundable } from '../cost-credit';
import { query } from '../../config/database';

const mockQuery = query as jest.MockedFunction<typeof query>;

const PARENT_ID = '11111111-1111-4111-8111-111111111111';

/** The purchase row `prepareCreditFromParent` reads, with overrides. */
const parentRow = (over: Record<string, unknown> = {}) => ({
  id: PARENT_ID, is_credit: false, amount_gross: '12.60', amount_vat: '2.10',
  supplier_name: 'Screwfix', recharge_mode: 'none', job_id: null, hh_job_number: null,
  xero_contact_id: 'xc-1', currency: 'GBP', vat_treatment: 'standard',
  payment_method: 'cot_card', cot_card_holder: 'Sam', cot_card_last4: '1234',
  xero_account_code: '412', category: 'Van parts', cost_type: 'vehicle',
  vehicle_id: 'veh-1', quote_assignment_id: null, job_issue_id: null,
  vehicle_service_log_id: null, vehicle_fuel_log_id: null,
  allocation_count: 0,
  ...over,
});

/** parent lookup, then the refundable-balance lookup. */
function givenParent(over: Record<string, unknown> = {}, refunded = '0') {
  mockQuery.mockResolvedValueOnce({ rows: [parentRow(over)] } as never);
  mockQuery.mockResolvedValueOnce({
    rows: [{ amount_gross: (over.amount_gross as string) ?? '12.60', refunded }],
  } as never);
}

beforeEach(() => jest.clearAllMocks());

describe('applyCreditSign', () => {
  it('stores a credit negative however the caller sent it', () => {
    const fromUi = { amount_gross: 12.6, amount_vat: 2.1, amount_net: 10.5 };
    applyCreditSign(fromUi, true);
    expect(fromUi).toEqual({ amount_gross: -12.6, amount_vat: -2.1, amount_net: -10.5 });

    // Already negative (a re-save of an edited credit) stays negative — not
    // flipped back to a purchase.
    const resave = { amount_gross: -12.6 };
    applyCreditSign(resave, true);
    expect(resave.amount_gross).toBe(-12.6);
  });

  it('keeps a purchase positive — a stray minus cannot create a credit', () => {
    const data = { amount_gross: -12.6, amount_vat: -2.1 };
    applyCreditSign(data, false);
    expect(data).toEqual({ amount_gross: 12.6, amount_vat: 2.1 });
  });

  it('leaves absent and zero fields alone rather than writing -0', () => {
    const data: Record<string, unknown> = { amount_gross: 12.6, amount_vat: 0, amount_net: null };
    applyCreditSign(data, true);
    expect(data.amount_gross).toBe(-12.6);
    expect(data.amount_vat).toBe(0);
    expect(data.amount_net).toBeNull();
    expect('description' in data).toBe(false);
  });
});

describe('remainingRefundable', () => {
  it('nets what has already come back off the purchase', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ amount_gross: '12.60', refunded: '6.00' }] } as never);
    await expect(remainingRefundable(PARENT_ID)).resolves.toEqual({ gross: 12.6, refunded: 6, remaining: 6.6 });
  });

  it('is null for a cost that no longer exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await expect(remainingRefundable(PARENT_ID)).resolves.toBeNull();
  });
});

describe('prepareCreditFromParent', () => {
  it('inherits the purchase\'s facets so the credit nets in the same place', async () => {
    givenParent();
    const data: Record<string, unknown> = { amount_gross: 12.6 };

    const prep = await prepareCreditFromParent(PARENT_ID, data);

    expect(prep.error).toBeUndefined();
    expect(data.vehicle_id).toBe('veh-1');          // the van stays accurate
    expect(data.xero_account_code).toBe('412');     // same account, both sides
    expect(data.cost_type).toBe('vehicle');
    expect(data.supplier_name).toBe('Screwfix');
    expect(data.payment_method).toBe('cot_card');   // back onto the same card
  });

  it('does not overwrite what the caller set deliberately', async () => {
    givenParent();
    const data: Record<string, unknown> = { amount_gross: 6, description: 'wrong-length screws', xero_account_code: '410' };

    await prepareCreditFromParent(PARENT_ID, data);

    expect(data.xero_account_code).toBe('410');
    expect(data.description).toBe('wrong-length screws');
  });

  it('is never payable, never a recharge', async () => {
    givenParent({ recharge_mode: 'full' });
    const data: Record<string, unknown> = { amount_gross: 12.6 };

    await prepareCreditFromParent(PARENT_ID, data);

    // Inheriting recharge_mode would put a REFUND on the Recharges tab asking
    // to be billed to a client.
    expect(data.recharge_mode).toBe('none');
    expect(data.recharge_amount).toBeNull();
    expect(data.payment_status).toBe('paid');
  });

  it('refuses more than the purchase', async () => {
    givenParent();
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 20 });
    expect(prep.error).toContain('more than the purchase');
  });

  it('counts refunds already taken against the ceiling', async () => {
    givenParent({}, '6.00');
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 8 });
    expect(prep.error).toContain('£6.60 is outstanding');
  });

  it('allows the exact remaining balance to the penny', async () => {
    givenParent({}, '6.00');
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 6.6 });
    expect(prep.error).toBeUndefined();
  });

  it('refuses a refund of a refund', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [parentRow({ is_credit: true, amount_gross: '-12.60' })] } as never);
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 5 });
    expect(prep.error).toContain('already a credit');
  });

  it('refuses a purchase that has gone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 5 });
    expect(prep.error).toContain('no longer exists');
  });

  it('warns — but does not block — when the purchase was recharged to a client', async () => {
    givenParent({ recharge_mode: 'full', job_id: 'job-1', hh_job_number: 15628 });
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 12.6 });

    expect(prep.error).toBeUndefined();
    expect(prep.warnings.join(' ')).toContain('#15628');
    // HireHop clamps a negative silently, so this has to be a person's job.
    expect(prep.warnings.join(' ')).toContain('HireHop');
  });

  it('warns when the purchase was split across jobs', async () => {
    givenParent({ allocation_count: 3 });
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 12.6 });
    expect(prep.warnings.join(' ')).toContain('split across 3 jobs');
  });

  it('refuses a zero refund rather than writing a £0 row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [parentRow()] } as never);
    const prep = await prepareCreditFromParent(PARENT_ID, { amount_gross: 0 });
    expect(prep.error).toContain('amount that came back');
  });
});
