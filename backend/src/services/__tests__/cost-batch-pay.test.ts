/**
 * Batch pay — the eligibility gate and the all-or-nothing rule.
 *
 * This is twenty payments at once, so the failure modes are twenty times worse.
 * The two that matter:
 *
 *   - Paying something that shouldn't be paid (already paid → paid twice; not
 *     in Xero → money recorded against nothing).
 *   - Paying SOME of the selection. Nineteen of twenty, with no record of which
 *     one was skipped, is harder to unpick than paying none.
 *
 * So every bill is checked before anything is sent, and one failure refuses the
 * lot by name. These pin that.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../xero-broker', () => ({
  xeroBroker: { createBatchPayment: jest.fn() },
  XeroApiError: class extends Error {},
}));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));

import { payCostsAsBatch } from '../cost-batch-pay';
import { query } from '../../config/database';
import { xeroBroker } from '../xero-broker';
import { getSystemSetting } from '../../routes/system-settings';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockBatch = xeroBroker.createBatchPayment as jest.MockedFunction<typeof xeroBroker.createBatchPayment>;
const mockSetting = getSystemSetting as jest.MockedFunction<typeof getSystemSetting>;

const bill = (over: Record<string, unknown> = {}) => ({
  id: over.id ?? '11111111-1111-4111-8111-111111111111',
  supplier_name: 'T.Reeve & Son', invoice_number: '93051',
  amount_gross: '100.00', currency: 'GBP',
  payment_method: 'not_yet_paid', payment_status: 'awaiting_payment',
  approval_state: 'approved',
  xero_object_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  xero_object_type: 'invoice', xero_payment_id: null,
  ...over,
});

const run = (rows: ReturnType<typeof bill>[]) => {
  mockQuery.mockResolvedValueOnce({ rows } as never);
  return payCostsAsBatch({
    costIds: rows.map((r) => r.id as string),
    paidMethod: 'lloyds_transfer', paidDate: '2026-09-30', userId: 'u1',
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSetting.mockResolvedValue('bank-acct-id');
  mockBatch.mockResolvedValue({ BatchPaymentID: 'batch-1', Payments: [] });
});

describe('payCostsAsBatch — refusals', () => {
  it('refuses an empty selection without calling Xero', async () => {
    const r = await payCostsAsBatch({ costIds: [], paidMethod: 'lloyds_transfer', userId: 'u1' });
    expect(r.paid).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('refuses a bill that is already paid — the double-payment case', async () => {
    const r = await run([bill({ payment_status: 'paid' })]);
    expect(r.paid).toBe(0);
    expect(r.error).toMatch(/already marked paid/);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('refuses a bill that already carries a Xero payment id', async () => {
    const r = await run([bill({ xero_payment_id: 'pay-1' })]);
    expect(r.error).toMatch(/already marked paid/);
  });

  it('refuses a bill that never reached Xero — nothing to pay against', async () => {
    const r = await run([bill({ xero_object_id: null })]);
    expect(r.error).toMatch(/no bill in Xero/);
  });

  it('refuses a paid-now cost — there is no outstanding bill', async () => {
    const r = await run([bill({ payment_method: 'cot_card', xero_object_type: 'banktransaction' })]);
    expect(r.error).toMatch(/paid-now cost/);
  });

  it('refuses an unapproved bill', async () => {
    const r = await run([bill({ approval_state: 'verified' })]);
    expect(r.error).toMatch(/still verified/);
  });

  it('refuses a non-GBP bill rather than guessing the conversion', async () => {
    const r = await run([bill({ currency: 'EUR' })]);
    expect(r.error).toMatch(/EUR/);
  });

  it('ONE bad bill refuses the whole batch, and names it', async () => {
    const r = await run([
      bill({ id: '11111111-1111-4111-8111-111111111111' }),
      bill({ id: '22222222-2222-4222-8222-222222222222', payment_status: 'paid', invoice_number: '93052' }),
      bill({ id: '33333333-3333-4333-8333-333333333333' }),
    ]);
    expect(r.paid).toBe(0);
    expect(r.error).toMatch(/Nothing was paid/);
    expect(r.error).toMatch(/#93052/);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('refuses when the pay method has no Xero bank account mapped', async () => {
    mockSetting.mockResolvedValue(null as never);
    const r = await run([bill()]);
    expect(r.error).toMatch(/No Xero bank account/);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('marks nothing paid when Xero rejects the batch', async () => {
    mockBatch.mockRejectedValue(new Error('Batch payments not enabled'));
    const r = await run([bill()]);
    expect(r.paid).toBe(0);
    expect(r.error).toMatch(/Nothing was paid/);
    expect(r.error).toMatch(/Batch payments not enabled/);
  });

  it('refuses when a selected cost has vanished, rather than paying the rest', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [bill()] } as never);
    const r = await payCostsAsBatch({
      costIds: ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'],
      paidMethod: 'lloyds_transfer', userId: 'u1',
    });
    expect(r.paid).toBe(0);
    expect(r.error).toMatch(/no longer exist/);
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

describe('payCostsAsBatch — the amounts sent to Xero', () => {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };

  beforeEach(async () => {
    client.query.mockClear(); client.release.mockClear();
    const { getClient } = await import('../../config/database');
    (getClient as jest.Mock).mockResolvedValue(client);
    mockQuery.mockResolvedValue({ rows: [] } as never);   // audit inserts
  });

  it('sends one payment per bill, each at its full gross', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        bill({ id: '11111111-1111-4111-8111-111111111111', amount_gross: '20.20' }),
        bill({ id: '22222222-2222-4222-8222-222222222222', amount_gross: '155.09',
               xero_object_id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
      ],
    } as never);

    const r = await payCostsAsBatch({
      costIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      paidMethod: 'lloyds_transfer', paidDate: '2026-09-30', userId: 'u1',
    });

    expect(r.paid).toBe(2);
    expect(r.total).toBe(175.29);
    const sent = mockBatch.mock.calls[0][0];
    expect(sent.payments).toEqual([
      { invoiceId: 'aaaaaaaa-0000-4000-8000-000000000001', amount: 20.20 },
      { invoiceId: 'aaaaaaaa-0000-4000-8000-000000000002', amount: 155.09 },
    ]);
    expect(sent.accountId).toBe('bank-acct-id');
    expect(sent.date).toBe('2026-09-30');
  });

  it('totals in pence, so a long run does not drift', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 3 }, (_, i) => bill({
        id: `${i + 1}1111111-1111-4111-8111-111111111111`, amount_gross: '0.10',
        xero_object_id: `aaaaaaaa-0000-4000-8000-00000000000${i + 1}`,
      })),
    } as never);
    const r = await payCostsAsBatch({
      costIds: ['11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111',
                '31111111-1111-4111-8111-111111111111'],
      paidMethod: 'lloyds_transfer', userId: 'u1',
    });
    expect(r.total).toBe(0.30);   // 0.1*3 is 0.30000000000000004 as floats
  });
});
