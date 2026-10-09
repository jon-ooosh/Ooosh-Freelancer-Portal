/**
 * The nightly Xero credit sweep (HIRE-CLOSE-OUT-SPEC.md §4.3 step 2): applies
 * in Xero what HireHop's allocations already say, never writes to HireHop,
 * is off until the setting says otherwise, and a job that does not add up is
 * logged and skipped rather than guessed at.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() }, hhBroker: { post: jest.fn(), get: jest.fn() } }));
jest.mock('../hh-deposit-release', () => ({ ...jest.requireActual('../hh-deposit-release'), readBillingRows: jest.fn() }));
jest.mock('../hh-xero-sync', () => ({ syncSavedRowToXero: jest.fn(), sendXeroSyncFailedAlert: jest.fn() }));
jest.mock('../shop-stock', () => ({ hhLocalNow: () => '2026-10-10 03:30:00' }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: () => true }));
jest.mock('../xero-broker', () => ({ __esModule: true, default: { getInvoice: jest.fn(), getOverpayment: jest.fn(), allocateOverpayment: jest.fn() } }));
jest.mock('../vat-adjustment', () => ({ hasNonStandardVatItem: jest.fn() }));
jest.mock('../../routes/webhooks', () => ({ handleJobStatusChange: jest.fn() }));
jest.mock('../hh-deposit', () => ({ getMethodForBankId: () => 'stripe_gbp', PAYMENT_METHODS_LABELS: { stripe_gbp: 'Stripe GBP' } }));

import { query } from '../../config/database';
import hhBroker from '../hirehop-broker';
import { readBillingRows } from '../hh-deposit-release';
import xeroBroker from '../xero-broker';
import { runCloseOutXeroSweep } from '../close-out-xero-sweep';

const mockQuery = query as jest.Mock;
const mockPost = (hhBroker as any).post as jest.Mock;
const mockRead = readBillingRows as jest.Mock;
const mockXeroInvoice = (xeroBroker as any).getInvoice as jest.Mock;
const mockXeroOverpayment = (xeroBroker as any).getOverpayment as jest.Mock;
const mockXeroAllocate = (xeroBroker as any).allocateOverpayment as jest.Mock;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 16015 as settled by hand in HireHop on 25 Sep: invoice 12252 paid by 9091 + 9093, nothing applied in Xero. */
function job16015Rows(opts: { noOverpayment?: boolean } = {}) {
  const deps = [
    { id: 9091, credit: 4629.82, allocated: 4629.82 },
    { id: 9093, credit: 1200, allocated: 1200 },
    { id: 8661, credit: 254.17, allocated: 254.17 },
  ];
  const rows: any[] = [
    { kind: 0, accrued: 5069.99, data: { TYPE: 0, TOTAL: 5069.99 } },
    { kind: 1, status: '3', debit: 6083.99, owing: 0, date: '2026-09-25', data: { ID: 12252, NUMBER: 'OT-INV-12252', STATUS: 3, NET: 5069.99, TAX: 1014, ACC_ID: 'x-12252', TAX_POINT: '2026-09-25' } },
  ];
  for (const d of deps) {
    rows.push({ kind: 6, credit: d.credit, owing: -(r2(d.credit - d.allocated)), paid: d.allocated, date: '2026-08-24',
      data: { ID: d.id, ACC_ACCOUNT_ID: 267, DESCRIPTION: '16015 - deposit', ACC_DATA: opts.noOverpayment && d.id === 9091 ? {} : { OverpaymentID: `op-${d.id}` } } });
    rows.push({ kind: 3, credit: -d.allocated, data: { ID: 900 + d.id, OWNER: 12252, OWNER_DEPOSIT: d.id, parent_is: 'deposit' } });
    rows.push({ kind: 3, credit: d.allocated, data: { ID: 900 + d.id, OWNER: 12252, OWNER_DEPOSIT: d.id, AMOUNT: d.allocated, parent_is: 'invoice' } });
  }
  return rows;
}

let enabled: string;
let jobs: Array<{ id: string; hh_job_number: number }>;
let logRows: any[];
let xero: { due: Record<string, number>; ops: Record<string, { remaining: number; allocations: any[] }> };

beforeEach(() => {
  jest.clearAllMocks();
  enabled = 'true';
  jobs = [{ id: 'j-16015', hh_job_number: 16015 }];
  logRows = [];
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM system_settings')) return { rows: [{ value: enabled }] };
    if (sql.includes('FROM jobs j')) return { rows: jobs };
    if (sql.includes('INSERT INTO job_closeout_log')) { logRows.push({ step: params[1], ok: params[2], detail: params[3] }); return { rows: [] }; }
    if (sql.includes('FROM job_closeout_log')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  mockRead.mockImplementation(async () => job16015Rows());
  xero = { due: { 'x-12252': 6083.99 }, ops: { 'op-9091': { remaining: 4629.82, allocations: [] }, 'op-9093': { remaining: 1200, allocations: [] }, 'op-8661': { remaining: 254.17, allocations: [] } } };
  mockXeroInvoice.mockImplementation(async (id: string) => (id in xero.due ? { InvoiceID: id, AmountDue: xero.due[id] } : null));
  mockXeroOverpayment.mockImplementation(async (id: string) => (xero.ops[id] ? { OverpaymentID: id, RemainingCredit: xero.ops[id].remaining, Allocations: xero.ops[id].allocations } : null));
  mockXeroAllocate.mockImplementation(async (a: any) => {
    xero.ops[a.overpaymentId].remaining = r2(xero.ops[a.overpaymentId].remaining - a.amount);
    xero.ops[a.overpaymentId].allocations.push({ Invoice: { InvoiceID: a.invoiceId }, Amount: a.amount });
    xero.due[a.invoiceId] = r2(xero.due[a.invoiceId] - a.amount);
  });
});

describe('runCloseOutXeroSweep', () => {
  it('does nothing while the setting is off', async () => {
    enabled = 'false';
    const r = await runCloseOutXeroSweep();
    expect(r).toMatchObject({ enabled: false, checked: 0 });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('applies every HireHop allocation as credit in Xero, writes nothing to HireHop, logs the job as swept', async () => {
    const r = await runCloseOutXeroSweep();
    expect(r).toMatchObject({ enabled: true, checked: 1, applied: 1, stopped: 0, errors: 0 });
    expect(mockXeroAllocate).toHaveBeenCalledTimes(3);
    expect(xero.due['x-12252']).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(logRows.at(-1)).toMatchObject({ step: 'sweep', ok: true });
    expect(logRows.at(-1).detail).toContain('credits applied');
  });

  it('a job already matching is logged clean and nothing is applied', async () => {
    xero.due['x-12252'] = 0;
    const r = await runCloseOutXeroSweep();
    expect(r).toMatchObject({ checked: 1, applied: 0 });
    expect(mockXeroAllocate).not.toHaveBeenCalled();
    expect(logRows.at(-1).detail).toContain('already matches');
  });

  it('a job that does not add up is logged and skipped, and the sweep carries on', async () => {
    jobs = [{ id: 'j-16015', hh_job_number: 16015 }, { id: 'j-other', hh_job_number: 16016 }];
    mockRead.mockImplementation(async (n: number) => job16015Rows({ noOverpayment: n === 16015 }));
    const r = await runCloseOutXeroSweep();
    expect(r).toMatchObject({ checked: 2, stopped: 1, applied: 1, errors: 0 });
    expect(logRows.some((l) => l.ok === false && /isn't in Xero as a payment/.test(l.detail))).toBe(true);
  });
});
