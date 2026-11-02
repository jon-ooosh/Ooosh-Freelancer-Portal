/**
 * A credit at the Xero boundary — the sign flip, and the VAT that rides on it.
 *
 * OP stores money-coming-back as a negative row. Xero carries the direction in
 * the transaction TYPE and wants POSITIVE lines, so exactly one place flips it:
 * `asMagnitudes()` in cost-xero-push.
 *
 * Getting that wrong is quiet rather than loud. A negative UnitAmount on a SPEND
 * would look almost right in the ledger, and `resolveLineTaxType` reads
 * `vat <= 0` as "no VAT" — so a credit's -£2.10 would push as TaxType NONE and
 * hand back the VAT reclaim on the refund without anything failing.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/r2', () => ({ getFromR2: jest.fn(), isR2Configured: () => false }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: () => true }));
jest.mock('../xero-broker', () => ({
  xeroBroker: {
    createSpendMoney: jest.fn(async () => ({ BankTransactionID: 'bt-1' })),
    getPurchaseTaxType: jest.fn(async () => 'INPUT2'),
  },
  XeroApiError: class extends Error {},
  XeroLineItem: {},
}));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn(async () => 'bank-acct-1') }));
jest.mock('../cost-documents', () => ({ collectDocuments: () => [], hasDocuments: () => false }));
jest.mock('../cost-lines', () => ({ fetchCostLines: async () => [], grossesWithResidue: () => [] }));

import { pushCostToXero } from '../cost-xero-push';
import { query, getClient } from '../../config/database';
import { xeroBroker } from '../xero-broker';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockGetClient = getClient as jest.MockedFunction<typeof getClient>;
const mockCreate = xeroBroker.createSpendMoney as jest.MockedFunction<typeof xeroBroker.createSpendMoney>;

const COST_ID = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  id: COST_ID,
  payment_method: 'cot_card', payment_status: 'paid', approval_state: null,
  amount_gross: '-12.60', amount_vat: '-2.10', amount_net: '-10.50',
  vat_treatment: 'standard', xero_account_code: '412',
  xero_object_id: null, xero_object_type: null, xero_payment_id: null,
  xero_sync_state: 'pending', supplier_name: 'Screwfix', invoice_number: null,
  description: 'Returned wrong-length screws', category: 'Van parts',
  cost_date: '2026-09-18', is_credit: true, refund_of_cost_id: 'parent-1',
  settled_externally: false, supporting_documents: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetClient.mockResolvedValue({ query: jest.fn(), release: jest.fn() } as never);
  mockCreate.mockResolvedValue({ BankTransactionID: 'bt-1' } as never);
});

describe('pushing a credit', () => {
  it('sends a RECEIVE with POSITIVE line amounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] } as never);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    const result = await pushCostToXero(COST_ID);

    expect(result.pushed).toBe(true);
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.type).toBe('RECEIVE');
    expect(sent.lineItems[0].UnitAmount).toBe(12.6);
  });

  it('keeps the VAT rate on the refund — the quiet one', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] } as never);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await pushCostToXero(COST_ID);

    // £2.10 on £10.50 is 20% — reading the stored -2.10 as "no VAT" would have
    // sent TaxType NONE and silently forfeited the reclaim.
    expect(xeroBroker.getPurchaseTaxType).toHaveBeenCalledWith(20);
    expect(mockCreate.mock.calls[0][0].lineItems[0].TaxType).toBe('INPUT2');
  });

  it('still sends a SPEND for an ordinary purchase', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({ is_credit: false, amount_gross: '12.60', amount_vat: '2.10', amount_net: '10.50' })],
    } as never);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await pushCostToXero(COST_ID);

    expect(mockCreate.mock.calls[0][0].type).toBeUndefined();
    expect(mockCreate.mock.calls[0][0].lineItems[0].UnitAmount).toBe(12.6);
  });

  it('refuses to raise a negative BILL — a credit note is a human job in Xero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ payment_method: 'not_yet_paid' })] } as never);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    const result = await pushCostToXero(COST_ID);

    expect(result.pushed).toBe(false);
    expect(result.skipped).toContain('credit note is manual');
    expect(mockCreate).not.toHaveBeenCalled();
    // ...and it says so on the row, rather than looking like a failed sync.
    const advisory = mockQuery.mock.calls.find((c) => String(c[1]?.[0] ?? '').includes('credit note'));
    expect(advisory).toBeDefined();
  });
});
