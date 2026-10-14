/**
 * A charge after completion (HIRE-CLOSE-OUT-SPEC.md §4.6) against a small fake of
 * HireHop's billing: an EMPTY draft (all: 0), custom lines only, every write read back,
 * approve + Xero only when the draft is exactly the charges. Refuses on anything but a
 * Completed job, and never builds on a draft that is already there.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => {
  const broker = { post: jest.fn(), get: jest.fn() };
  return { __esModule: true, default: broker, hhBroker: broker };
});
jest.mock('../hh-deposit-release', () => ({ ...jest.requireActual('../hh-deposit-release'), readBillingRows: jest.fn() }));
jest.mock('../hh-xero-sync', () => ({ syncSavedRowToXero: jest.fn(), sendXeroSyncFailedAlert: jest.fn() }));
jest.mock('../shop-stock', () => ({ hhLocalNow: () => '2026-10-13 10:00:00' }));
jest.mock('../hire-close-out', () => {
  const { Stop } = jest.requireActual('../hh-invoice-close');
  const logs: any[] = [];
  return {
    __logs: logs,
    loadJob: jest.fn(),
    withJobLock: (_id: string, fn: () => unknown) => fn(),
    log: jest.fn(async (_j: string, _u: string | null, step: string, ok: boolean, detail: string) => { logs.push({ step, ok, detail }); }),
    reporter: () => ({
      log: async (step: string, ok: boolean, detail: string) => { logs.push({ step, ok, detail }); },
      stop: async (step: string, detail: string) => { logs.push({ step, ok: false, detail }); throw new Stop(detail); },
      retryHint: 'try again',
    }),
    planHireCloseOut: jest.fn().mockResolvedValue({}),
  };
});

import { query } from '../../config/database';
import hhBroker from '../hirehop-broker';
import { readBillingRows } from '../hh-deposit-release';
import { syncSavedRowToXero } from '../hh-xero-sync';
import * as closeOut from '../hire-close-out';
import { raiseChargeInvoice } from '../completed-charges';
import { isChargeOnlyInvoice } from '../hh-invoice-close';

const mockQuery = query as jest.Mock;
const mockPost = (hhBroker as any).post as jest.Mock;
const mockGet = (hhBroker as any).get as jest.Mock;
const mockRead = readBillingRows as jest.Mock;
const mockSync = syncSavedRowToXero as jest.Mock;
const logs = (closeOut as any).__logs as any[];
const r2 = (n: number) => Math.round(n * 100) / 100;

let hh: { status: number; invoices: any[]; nextId: number; nextLine: number; draftWithJobLines: boolean };
let job: { id: string; hh_job_number: number; pipeline_status: string };

function rows() {
  return hh.invoices.map((inv) => {
    const net = r2(inv.items.reduce((s: number, l: any) => s + l.PRICE, 0));
    const tax = r2(inv.items.reduce((s: number, l: any) => s + l.VAT, 0));
    return { kind: 1, status: String(inv.status), debit: r2(net + tax), owing: r2(net + tax),
      data: { ID: inv.id, STATUS: inv.status, NUMBER: inv.number, NET: net, TAX: tax, ACC_ID: inv.accId, items: inv.items.map((l: any) => ({ ...l })) } };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  logs.length = 0;
  hh = { status: 11, invoices: [{ id: 500, status: 3, number: 'OT-INV-12308', accId: 'x-500', items: [{ ID: 1, MAIN_ID: 9001, KIND: 2, PRICE: 235.42, VAT: 47.08 }] }], nextId: 600, nextLine: 9000, draftWithJobLines: false };
  job = { id: 'job-uuid', hh_job_number: 15745, pipeline_status: 'completed' };
  (closeOut.loadJob as jest.Mock).mockImplementation(async () => job);
  mockQuery.mockResolvedValue({ rows: [] });
  mockRead.mockImplementation(async () => rows());
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/api/job_data.php') return { success: true, data: { STATUS: hh.status } };
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (path: string, body: any) => {
    if (path === '/php_functions/billing_save.php') {
      const items = hh.draftWithJobLines ? [{ ID: hh.nextLine++, MAIN_ID: 9002, KIND: 2, PRICE: 10, VAT: 2 }] : [];
      hh.invoices.push({ id: hh.nextId++, status: 0, number: '', accId: '', items, all: body.all });
      return { success: true, data: {} };
    }
    if (path === '/php_functions/billing_save_item.php' && body.id === 0) {
      const inv = hh.invoices.find((i) => i.id === body.bill);
      inv.items.push({ ID: hh.nextLine++, MAIN_ID: 0, KIND: 3, DESCRIPTION: body.note, PRICE: body.total, VAT: r2(body.total * body.vat_rate / 100),
        ACC_TAX_RATE_ID: body.vat_id, ACC_NOMINAL_ID: body.nominal_id });
      return { success: true, data: {} };
    }
    if (path === '/php_functions/billing_save_status.php') {
      const inv = hh.invoices.find((i) => i.id === body.id);
      inv.status = 2; inv.number = `OT-INV-${inv.id}`;
      return { success: true, data: { hh_task: 'post_invoice_credit', hh_id: inv.id } };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  mockSync.mockImplementation(async (_l: string, saved: any) => {
    const inv = hh.invoices.find((i) => i.id === saved.hh_id);
    if (inv) inv.accId = `x-${inv.id}`;
    return { ok: true, error: null };
  });
});

const posts = (path: string) => mockPost.mock.calls.filter((c) => c[0] === path).map((c) => c[1]);
const misc = (description: string, amount: number) => ({ type: 'misc' as const, description, amount });

describe('raiseChargeInvoice', () => {
  it('raises an empty draft, adds the custom line, approves and sends it to Xero — the job is never touched', async () => {
    const r = await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('Replacement DI box', 25)], reason: 'Lost on tour' });
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([expect.objectContaining({ all: 0, job: 15745 })]);
    expect(posts('/php_functions/billing_save_item.php')).toEqual([
      expect.objectContaining({ id: 0, kind: 3, note: 'Replacement DI box', total: 25, vat_rate: 20, vat_id: 20, nominal_id: 190 }),
    ]);
    expect(posts('/php_functions/billing_save_status.php')).toEqual([expect.objectContaining({ id: 600, status: 2 })]);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(r.message).toContain('OT-INV-600 raised for £30.00');
    expect(mockPost.mock.calls.map((c) => c[0])).not.toContain('/api/save_job.php');   // no job lines, ever
    // On the job's timeline, with the reason.
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO interactions') && String(c[1][1]).includes('Lost on tour'))).toBe(true);
  });

  it('a PCN: handling fee at 20%, the fine zero-rated, on one invoice', async () => {
    const r = await raiseChargeInvoice('15745', null, {
      lines: [{ type: 'pcn_handling', description: 'PCN AB123 — handling fee', amount: 35 }, { type: 'pcn_fine', description: 'PCN AB123 — fine', amount: 65 }],
      reason: 'PCN AB123',
    });
    expect(r.done).toBe(true);
    const lines = posts('/php_functions/billing_save_item.php');
    expect(lines.map((l) => [l.total, l.vat_rate, l.vat_id])).toEqual([[35, 20, 20], [65, 0, 33]]);
    expect(r.message).toContain('£107.00');
  });

  it('refuses on a job that isn\'t Completed — nothing written', async () => {
    job.pipeline_status = 'returned';
    const r = await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('X', 10)], reason: 'y' });
    expect(r.done).toBe(false);
    expect(r.message).toContain('isn\'t Completed');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses when HireHop doesn\'t show the job Completed', async () => {
    hh.status = 7;
    const r = await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('X', 10)], reason: 'y' });
    expect(r.done).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('never builds on a draft already on the job', async () => {
    hh.invoices.push({ id: 590, status: 0, number: '', accId: '', items: [] });
    const r = await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('X', 10)], reason: 'y' });
    expect(r.done).toBe(false);
    expect(r.message).toContain('already has a draft');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('stops at the draft if HireHop put job lines on it — never approved', async () => {
    hh.draftWithJobLines = true;
    const r = await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('X', 10)], reason: 'y' });
    expect(r.done).toBe(false);
    expect(r.message).toContain('must be empty');
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('needs a reason and a description', async () => {
    expect((await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc('X', 10)], reason: ' ' })).done).toBe(false);
    expect((await raiseChargeInvoice('job-uuid', 'u1', { lines: [misc(' ', 10)], reason: 'y' })).done).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('isChargeOnlyInvoice', () => {
  it('custom lines only = a charge invoice; any job line = not', () => {
    expect(isChargeOnlyInvoice({ data: { items: [{ MAIN_ID: 0, KIND: 3 }] } })).toBe(true);
    expect(isChargeOnlyInvoice({ data: { items: [{ MAIN_ID: 0, KIND: 3 }, { MAIN_ID: 168520, KIND: 2 }] } })).toBe(false);
    expect(isChargeOnlyInvoice({ data: { items: [] } })).toBe(false);
  });
});
