/**
 * The Wise matcher's invoice-number tier and the double-record guard.
 *
 * Job 16387 (2 Nov 2026): £3,042 from Skindred Llp, reference "OT-INV-12347" — the
 * exact balance on that invoice — was queued because the matcher only read the
 * billing of the 80 jobs with the latest start dates (16387 was 196th). It now looks
 * the number up in OP's own invoice list (hh_invoice_index) first, and only on a miss
 * reads the billing of jobs that still owe money. A colleague then recorded the money
 * from the Money tab, and the queue's Record button would have recorded it again.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() }, hhBroker: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../email-service', () => ({ emailService: { send: jest.fn() } }));
jest.mock('../../config/app-urls', () => ({ frontendLink: (p: string) => p }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn().mockResolvedValue(null) }));
jest.mock('../record-payment', () => ({ recordPayment: jest.fn(), SYSTEM_SERVICE_USER_ID: 'system-user' }));
jest.mock('../xero-broker', () => ({ xeroBroker: { getInvoices: jest.fn() } }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: () => false }));

import { query } from '../../config/database';
import { hhBroker } from '../hirehop-broker';
import { recordPayment } from '../record-payment';
import { matchIncomingPayment, recordIncomingPaymentOnJob } from '../wise-incoming';
import { invoicesFromBillingRows, invoiceDigits } from '../hh-invoice-index';

const mockQuery = query as jest.Mock;
const mockHhGet = (hhBroker as any).get as jest.Mock;
const mockRecordPayment = recordPayment as jest.Mock;

/** Job 16387 as it stood: £4,050 inc VAT, £1,008 deposit paid, OT-INV-12347 owing £3,042. */
const job16387 = {
  id: 'job-16387', hh_job_number: 16387, job_name: 'Skindred', client_name: 'Simon Hutchby',
  company_name: null, job_value: '3375', pipeline_status: 'completed',
};
const billing16387 = [
  { kind: 0, accrued: 3375 },
  { kind: 6, credit: 1008, data: { ID: 8931, DESCRIPTION: '16387 - deposit' } },
  { kind: 1, debit: 4050, owing: 3042, data: { ID: 555, NUMBER: 'OT-INV-12347', STATUS: 2 } },
  { kind: 1, debit: 0, owing: 0, data: { ID: 556, NUMBER: '', STATUS: 0 } },   // a draft: no number
];

let indexRows: any[];
let poolRows: any[];
let job = job16387;

beforeEach(() => {
  indexRows = [];
  poolRows = [];
  job = { ...job16387 };
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM hh_invoice_index')) return { rows: indexRows };
    if (sql.includes('id = ANY($1::uuid[])')) return { rows: [job] };
    if (sql.includes('hire_value_inc_vat FROM job_financials')) return { rows: [{ hire_value_inc_vat: '4050.00' }] };
    if (sql.includes('FROM job_financials jf')) return { rows: poolRows };
    if (sql.includes('WHERE id = $1') && sql.includes('FROM jobs')) return { rows: [job] };
    return { rows: [] };   // index writes, payer-name search, excess records
  });
  mockHhGet.mockReset();
  mockHhGet.mockResolvedValue({ success: true, data: { rows: billing16387 } });
  mockRecordPayment.mockReset();
});

const transfer = () =>
  matchIncomingPayment({ payerName: 'Skindred Llp', amount: 3042, currency: 'GBP', reference: 'OT-INV-12347' });

describe('invoice list helpers', () => {
  it('reads numbered invoices only, and their digits', () => {
    const inv = invoicesFromBillingRows(billing16387);
    expect(inv).toEqual([{ id: 555, number: 'OT-INV-12347', digits: '12347', status: 2, total: 4050, owing: 3042 }]);
    expect(invoiceDigits('OT-INV-012347')).toBe('12347');
    expect(invoicesFromBillingRows(undefined)).toEqual([]);
  });
});

describe('Wise matcher — invoice number in the reference', () => {
  it('finds job 16387 from the invoice list and records the balance', async () => {
    indexRows = [{ hh_invoice_id: 555, invoice_number: 'OT-INV-12347', job_id: 'job-16387', hh_job_number: 16387, owing: '3042.00' }];
    const out = await transfer();
    expect(out.kind).toBe('confident');
    expect(out.paymentType).toBe('balance');
    expect(out.job?.hh_job_number).toBe(16387);
    expect(out.candidates[0].expected).toMatchObject({ remaining: 3042, invoice: 3042 });
    // Only the job's own billing read for its figures — no sweep across other jobs
    expect(mockHhGet).toHaveBeenCalledTimes(1);
  });

  it('on a miss, reads the billing of jobs that still owe money and finds it there', async () => {
    poolRows = [
      { ...job16387, id: 'job-other', hh_job_number: 16000 },
      job16387,
    ];
    mockHhGet.mockImplementation(async (_e: string, params: { main_id: number }) =>
      ({ success: true, data: { rows: params.main_id === 16387 ? billing16387 : [] } }));
    const out = await transfer();
    expect(out.kind).toBe('confident');
    expect(out.job?.hh_job_number).toBe(16387);
    expect(out.notes).toContain('found by reading billing');
  });

  it('says so when the invoice is nowhere, instead of "no invoice number"', async () => {
    mockHhGet.mockResolvedValue({ success: true, data: { rows: [] } });
    const out = await transfer();
    expect(out.kind).toBe('unmatched');
    expect(out.notes).toContain('invoice 12347 not found');
    expect(out.notes).not.toContain('no job or invoice number');
  });

  it('never records automatically on a cancelled job (it owes its fee, not the hire)', async () => {
    job = { ...job16387, pipeline_status: 'cancelled' };
    indexRows = [{ hh_invoice_id: 555, invoice_number: 'OT-INV-12347', job_id: 'job-16387', hh_job_number: 16387, owing: '3042.00' }];
    const out = await transfer();
    expect(out.kind).toBe('unmatched');
    expect(out.notes).toContain('cancelled');
  });
});

describe('double-record guard', () => {
  const incoming = { id: 'inc-1', status: 'unmatched', amount: '3042.00', received_at: new Date('2026-11-02T16:24:47Z'), transfer_number: '2470249676', reference: 'OT-INV-12347' };
  const handRecorded = { id: 'pay-1', amount: '3042.00', payment_type: 'balance', payment_method: 'wise_bacs', payment_date: new Date('2026-11-02T17:00:00Z'), hirehop_deposit_id: 9555, recorded_by_name: 'Sam' };

  const routeQueries = (existing: any[]) => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM incoming_bank_payments')) return { rows: [incoming] };
      if (sql.includes('FROM job_payments jp')) return { rows: existing };
      return { rows: [] };
    });
  };
  const opts = { incomingId: 'inc-1', jobId: 'job-16387', paymentType: 'balance' as const, actorUserId: 'u1', matchMethod: 'manual', matchNotes: 'by hand' };

  it('refuses when the same money is already on the job, and says whose', async () => {
    routeQueries([handRecorded]);
    const r = await recordIncomingPaymentOnJob(opts);
    expect(r.ok).toBe(false);
    expect(r.existing?.id).toBe('pay-1');
    expect(r.error).toContain('already recorded on this job by Sam');
    expect(r.error).toContain('HireHop deposit 9555');
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it('records anyway when a person says it is a second payment', async () => {
    routeQueries([handRecorded]);
    mockRecordPayment.mockResolvedValue({ status: 200, body: { data: { id: 'pay-2', hirehop_deposit_id: 9600 } } });
    const r = await recordIncomingPaymentOnJob({ ...opts, allowDuplicate: true });
    expect(r.ok).toBe(true);
    expect(mockRecordPayment).toHaveBeenCalledTimes(1);
  });

  it('records normally when nothing matching is on the job', async () => {
    routeQueries([]);
    mockRecordPayment.mockResolvedValue({ status: 200, body: { data: { id: 'pay-2' } } });
    const r = await recordIncomingPaymentOnJob(opts);
    expect(r.ok).toBe(true);
    expect(mockRecordPayment).toHaveBeenCalledTimes(1);
  });
});
