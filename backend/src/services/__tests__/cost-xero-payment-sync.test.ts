/**
 * Bill payment pull-back — what it marks paid, and what it refuses to touch.
 *
 * This sync exists to stop OP paying a supplier twice, so the failure that
 * matters is the opposite one: marking something paid that Xero has not
 * actually settled. A part-paid bill is still owed; a voided bill is a real
 * discrepancy someone needs to see. Both must stay on Bills to Pay.
 *
 * The other pinned behaviour is the credit-note case: paid in Xero with no
 * Payment on it. There is no payment id to hold, so the row is flagged
 * `settled_externally` — the flag every push path reads as "never record a
 * payment for this" — rather than left in the exact shape that invites one.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: jest.fn(() => true) }));
jest.mock('../xero-broker', () => ({ xeroBroker: { getInvoices: jest.fn() } }));
jest.mock('../cost-xero-push', () => ({
  BILL_METHODS: ['not_yet_paid', 'reimburse_me'],
  withCostPushLock: (_id: string, fn: () => Promise<unknown>) => fn(),
}));

import { runCostXeroPaymentSync, xeroDateToISO } from '../cost-xero-payment-sync';
import { query } from '../../config/database';
import { xeroBroker } from '../xero-broker';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockInvoices = xeroBroker.getInvoices as jest.MockedFunction<typeof xeroBroker.getInvoices>;

const COST_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** One outstanding candidate, then the in-lock re-read that finds it still unpaid. */
function givenOneOutstandingBill() {
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: COST_ID, xero_object_id: INVOICE_ID, amount_gross: '490.60', supplier_name: 'Hi-Q Portslade' }],
  } as never);
  mockQuery.mockResolvedValue({
    rows: [{ payment_status: 'awaiting_payment', approval_state: 'approved', settled_externally: false, xero_payment_id: null }],
  } as never);
}

/** The UPDATE the sync ran, as [sql, params]. */
const updateCall = () =>
  mockQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE costs'));

/** The parameters the UPDATE was run with. */
const updateParams = () => (updateCall()![1] ?? []) as unknown[];

beforeEach(() => jest.clearAllMocks());

describe('xeroDateToISO', () => {
  it('parses Xero\'s /Date(…)/ wire format', () => {
    expect(xeroDateToISO('/Date(1518685950940+0000)/')).toBe('2018-02-15');
  });
  it('parses a plain ISO date', () => {
    expect(xeroDateToISO('2026-09-16T00:00:00')).toBe('2026-09-16');
  });
  it('returns null for nothing usable', () => {
    expect(xeroDateToISO(null)).toBeNull();
    expect(xeroDateToISO('not a date')).toBeNull();
  });
});

describe('runCostXeroPaymentSync', () => {
  it('marks a bill paid using XERO\'S payment id and date', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockResolvedValue([{
      InvoiceID: INVOICE_ID, Status: 'PAID', AmountDue: 0, AmountPaid: 490.6,
      Payments: [{ PaymentID: 'pay-1', Date: '/Date(1757980800000+0000)/', Amount: 490.6 }],
    }] as never);

    const r = await runCostXeroPaymentSync();

    expect(r).toEqual({ checked: 1, marked: 1 });
    // [paidDate, paymentId, settledExternally, note, costId]
    expect(updateParams()).toEqual(['2025-09-16', 'pay-1', false, null, COST_ID]);
  });

  it('takes the LATEST payment where a bill was settled in instalments', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockResolvedValue([{
      InvoiceID: INVOICE_ID, Status: 'PAID', AmountDue: 0,
      Payments: [
        { PaymentID: 'pay-early', Date: '2026-08-01T00:00:00', Amount: 200 },
        { PaymentID: 'pay-final', Date: '2026-09-10T00:00:00', Amount: 290.6 },
      ],
    }] as never);

    await runCostXeroPaymentSync();

    expect(updateParams()[0]).toBe('2026-09-10');
    expect(updateParams()[1]).toBe('pay-final');
  });

  it('flags a bill cleared in Xero WITHOUT a payment as settled externally', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockResolvedValue([{
      InvoiceID: INVOICE_ID, Status: 'PAID', AmountDue: 0, Payments: [],
    }] as never);

    await runCostXeroPaymentSync();

    expect(updateParams()[1]).toBeNull();   // no payment id to hold
    expect(updateParams()[2]).toBe(true);   // settled_externally — never push a payment for it
  });

  it('leaves a PART-paid bill alone — it is still owed', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockResolvedValue([{
      InvoiceID: INVOICE_ID, Status: 'AUTHORISED', AmountDue: 290.6, AmountPaid: 200,
      Payments: [{ PaymentID: 'pay-1', Date: '2026-09-01T00:00:00', Amount: 200 }],
    }] as never);

    const r = await runCostXeroPaymentSync();

    expect(r.marked).toBe(0);
    expect(updateCall()).toBeUndefined();
  });

  it('leaves a VOIDED bill alone rather than hiding the discrepancy', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockResolvedValue([{ InvoiceID: INVOICE_ID, Status: 'VOIDED', AmountDue: 0 }] as never);

    const r = await runCostXeroPaymentSync();

    expect(r.marked).toBe(0);
    expect(updateCall()).toBeUndefined();
  });

  it('does not touch a row that got paid in OP while the chunk was in flight', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: COST_ID, xero_object_id: INVOICE_ID, amount_gross: '490.60', supplier_name: 'Hi-Q' }],
    } as never);
    // The in-lock re-read finds a real OP payment already recorded.
    mockQuery.mockResolvedValue({
      rows: [{ payment_status: 'paid', approval_state: 'paid', settled_externally: false, xero_payment_id: 'pay-op' }],
    } as never);
    mockInvoices.mockResolvedValue([{
      InvoiceID: INVOICE_ID, Status: 'PAID', AmountDue: 0,
      Payments: [{ PaymentID: 'pay-op', Date: '2026-09-10T00:00:00', Amount: 490.6 }],
    }] as never);

    const r = await runCostXeroPaymentSync();

    expect(r.marked).toBe(0);
    expect(updateCall()).toBeUndefined();
  });

  it('survives a Xero blip without throwing — tomorrow\'s run catches up', async () => {
    givenOneOutstandingBill();
    mockInvoices.mockRejectedValue(new Error('429'));

    await expect(runCostXeroPaymentSync()).resolves.toEqual({ checked: 1, marked: 0 });
  });

  it('asks Xero nothing when there is nothing outstanding', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    const r = await runCostXeroPaymentSync();

    expect(r).toEqual({ checked: 0, marked: 0 });
    expect(mockInvoices).not.toHaveBeenCalled();
  });
});
