/**
 * The Wise matcher's amount check: a transfer naming one job is recorded on its own only
 * when the amount is one of the figures that job expects. Half counts to the pound (the
 * portal's "Half now") or to the penny — job 16383 (23 Oct 2026) sent exactly 50%,
 * £3,447.30, and was queued because only the portal's £3,447 was accepted.
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
import { matchIncomingPayment } from '../wise-incoming';

const mockQuery = query as jest.Mock;
const mockHhGet = (hhBroker as any).get as jest.Mock;

/** Job 16383 as it stood when the transfer arrived: £6,894.60 inc VAT, nothing paid, no excess. */
const job16383 = {
  id: 'job-16383', hh_job_number: 16383, job_name: 'Backline', client_name: 'JOY Concerts Ltd',
  company_name: 'JOY Concerts Ltd', job_value: '5745.50', pipeline_status: 'provisional',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('hh_job_number = ANY')) return { rows: [job16383] };
    if (sql.includes('FROM job_financials')) return { rows: [{ hire_value_inc_vat: '6894.60' }] };
    return { rows: [] };   // payer-name search, excess records
  });
  mockHhGet.mockReset();
  mockHhGet.mockResolvedValue({ success: true, data: { rows: [] } });   // no deposits on HireHop yet
});

const transfer = (amount: number) =>
  matchIncomingPayment({ payerName: 'JOY LTD SW FMQ', amount, currency: 'GBP', reference: 'Job 16383' });

describe('Wise matcher — half', () => {
  it('records exact 50% to the penny (£3,447.30) as the deposit', async () => {
    const out = await transfer(3447.30);
    expect(out.kind).toBe('confident');
    expect(out.paymentType).toBe('deposit');
    expect(out.job?.hh_job_number).toBe(16383);
    expect(out.candidates[0].expected).toMatchObject({ half: 3447, halfExact: 3447.3 });
  });

  it("still records the portal's whole-pound half (£3,447)", async () => {
    const out = await transfer(3447);
    expect(out.kind).toBe('confident');
    expect(out.paymentType).toBe('deposit');
  });

  it('still queues an amount that is neither (£3,447.50)', async () => {
    const out = await transfer(3447.50);
    expect(out.kind).toBe('unmatched');
    expect(out.method).toBe('amount_mismatch');
  });
});
