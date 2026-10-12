/**
 * The EU invoice VAT split (HIRE-CLOSE-OUT-SPEC.md §10.1) against a small fake
 * of HireHop's draft invoice that recomputes NET / VAT per line as HireHop does.
 *
 * Job 15812 is the reference: staff split it by hand in Jul 2026 to £20.06 at
 * 20% + £260.74 at 0% = £284.81, the figure the payment portal charged. OP
 * must arrive at exactly that, keep the nominal, write the custom lines before
 * zeroing the real ones, read back every write, and check the result against
 * the portal's own figure.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => {
  const broker = { post: jest.fn(), get: jest.fn() };
  return { __esModule: true, default: broker, hhBroker: broker };
});
jest.mock('../hh-deposit-release', () => ({ ...jest.requireActual('../hh-deposit-release'), readBillingRows: jest.fn() }));
jest.mock('../hh-xero-sync', () => ({ syncSavedRowToXero: jest.fn(), sendXeroSyncFailedAlert: jest.fn() }));
jest.mock('../shop-stock', () => ({ hhLocalNow: () => '2026-10-12 09:00:00' }));

import { query } from '../../config/database';
import hhBroker from '../hirehop-broker';
import { readBillingRows } from '../hh-deposit-release';
import { Stop } from '../hh-invoice-close';
import { splitEuDraft, planEuSplit } from '../eu-vat-split';

const mockQuery = query as jest.Mock;
const mockPost = (hhBroker as any).post as jest.Mock;
const mockGet = (hhBroker as any).get as jest.Mock;
const mockRead = readBillingRows as jest.Mock;
const r2 = (n: number) => Math.round(n * 100) / 100;

const DRAFT = 12950;
const NOMINALS = [{ ID: 175, CODE: '200', NAME: 'Backline hire' }, { ID: 243, CODE: '256', NAME: 'Panel van hire' }, { ID: 178, CODE: '215', NAME: 'Delivery / collection' }];

let job: { start: string; end: string };
let supply: any[];
let margins: Array<{ idx: number; revenue: number }>;
let lines: any[];
let nextLine: number;
let zeroMode: 'edit' | 'noop' | 'duplicate';
let order: string[];

function draftRow() {
  const net = r2(lines.reduce((s, l) => s + l.PRICE, 0));
  const tax = r2(lines.reduce((s, l) => s + l.VAT, 0));
  return { kind: 1, status: '0', debit: r2(net + tax), owing: r2(net + tax), data: { ID: DRAFT, STATUS: 0, NUMBER: '', NET: net, TAX: tax, items: lines.map((l) => ({ ...l })), nominal_codes: NOMINALS } };
}
const vatOf = (price: number, rate: number) => r2(price * rate / 100);
const jobLine = (id: number, price: number, nominal: number, extra: Record<string, unknown> = {}) => ({
  ID: 96000 + id, MAIN_ID: id, KIND: 2, EQUIP_ID: 1000 + id, QTY: 1, UNIT_PRICE: price, MULTIPLIER: 1, BASE_UNIT_PRICE: price,
  DESCRIPTION: `Item ${id}`, ITEM: `Item ${id}`, MEMO: '', FROM: '2026-06-02 09:00:00.000000', UPTO: '2026-06-30 09:00:00.000000',
  PRICE: price, VAT_RATE: 20, VAT: vatOf(price, 20), ACC_NOMINAL_ID: nominal, ACC_TAX_RATE_ID: 20, ...extra,
});
const trigger = (days: number) => ({ ID: 1, kind: 2, title: 'Non-standard VAT rules - number of days outside of UK', qty: days, ACC_NOMINAL: 24, CATEGORY_ID: 300 });
const backline = (id: number) => ({ ID: id, kind: 2, title: `Item ${id}`, ACC_NOMINAL: 24, CATEGORY_ID: 300 });

/** 15812 as drafted: four backline lines at 40% off, £280.80 ex VAT, 26 of 28 days outside the UK. */
function job15812() {
  job = { start: '2026-06-02T09:00:00Z', end: '2026-06-30T09:00:00Z' };
  supply = [backline(152767), backline(152762), backline(152760), backline(152761), trigger(26)];
  margins = [{ idx: 124, revenue: 280.8 }];
  lines = [jobLine(152767, 28.8, 175), jobLine(152762, 72, 175), jobLine(152760, 144, 175), jobLine(152761, 36, 175)];
}

function install() {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM jobs WHERE')) return { rows: [{ job_date: job.start, job_end: job.end }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  mockRead.mockImplementation(async () => [draftRow()]);
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/frames/items_to_supply_list.php') return { success: true, data: supply };
    if (path === '/php_functions/job_margins.php') {
      return { success: true, data: { total_revenue: r2(margins.reduce((s, m) => s + m.revenue, 0)), nominals: margins } };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (path: string, body: any) => {
    if (path === '/php_functions/billing_save_item.php' && body.id === 0) {   // custom line
      order.push('custom');
      lines.push({ ID: nextLine++, MAIN_ID: 0, KIND: 3, DESCRIPTION: body.note, PRICE: body.total, VAT_RATE: body.vat_rate,
        VAT: vatOf(body.total, body.vat_rate), ACC_NOMINAL_ID: body.nominal_id, ACC_TAX_RATE_ID: body.vat_id });
      return { success: true, data: {} };
    }
    if (path === '/php_functions/billing_save_item.php') {           // one line edited in place, by its id
      const l = lines.find((x) => x.ID === body.id);
      order.push(body.total === 0 ? 'zero' : 'tax');
      expect(body.selected).toBe(body.id);
      expect(body.nominal_id).toBe(l.ACC_NOMINAL_ID);                // nominal sent back unchanged
      if (zeroMode === 'noop') return { success: true, data: {} };   // "success" that did nothing (§0)
      if (zeroMode === 'duplicate') {                                // what the ASSIGN call did on 15745
        lines.push({ ...l, ID: nextLine++, PRICE: 0, VAT: 0 });
        return { success: true, data: {} };
      }
      l.PRICE = body.total; l.ACC_TAX_RATE_ID = body.vat_id; l.VAT_RATE = body.vat_rate; l.VAT = vatOf(l.PRICE, body.vat_rate);
      return { success: true, data: {} };
    }
    throw new Error(`unexpected POST ${path}`);
  });
}

const rep = () => ({
  log: jest.fn(async () => undefined),
  stop: jest.fn(async (_step: string, detail: string) => { throw new Stop(detail); }),
  retryHint: 'press Carry on',
});
const run = (r = rep(), firstInvoice = true) => splitEuDraft(r, { jobId: 'j1', hhJobNumber: 15812, draftId: DRAFT, firstInvoice });

beforeEach(() => {
  jest.clearAllMocks();
  nextLine = 97000; zeroMode = 'edit'; order = [];
  job15812();
  install();
});

describe('splitEuDraft', () => {
  it('15812: £20.06 at 20% + £260.74 zero-rated on the same nominal, real lines at 100% discount — £284.81, as the portal charged', async () => {
    const r = rep();
    expect(await run(r)).toBe('split');
    const custom = lines.filter((l) => l.KIND === 3);
    expect(custom).toEqual([
      expect.objectContaining({ DESCRIPTION: 'Backline hire, UK days (2 of 28)', PRICE: 20.06, ACC_TAX_RATE_ID: 20, ACC_NOMINAL_ID: 175 }),
      expect.objectContaining({ DESCRIPTION: 'Backline hire, non-UK days, zero-rated (HMRC 741A) (26 of 28)', PRICE: 260.74, ACC_TAX_RATE_ID: 33, ACC_NOMINAL_ID: 175 }),
    ]);
    expect(lines.filter((l) => l.KIND === 2).every((l) => l.PRICE === 0)).toBe(true);
    expect(draftRow()).toMatchObject({ debit: 284.81, data: { NET: 280.8, TAX: 4.01 } });
    // Custom lines BEFORE zeroing, so a half-done draft fails the penny check.
    expect(order).toEqual(['custom', 'custom', 'zero', 'zero', 'zero', 'zero']);
    expect(r.stop).not.toHaveBeenCalled();
  });

  it('a draft already split is checked again and not touched', async () => {
    await run();
    mockPost.mockClear();
    expect(await run()).toBe('checked');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('stops — nothing more written — when HireHop says success but the line kept its price', async () => {
    zeroMode = 'noop';
    await expect(run()).rejects.toThrow('did not put "Item 152767" at £0');
    expect(order).toEqual(['custom', 'custom', 'zero']);
  });

  it('stops when HireHop adds a second copy of the line instead of editing it (15745, 12 Oct 2026)', async () => {
    zeroMode = 'duplicate';
    await expect(run()).rejects.toThrow('did not put "Item 152767" at £0');
    expect(order).toEqual(['custom', 'custom', 'zero']);
  });

  it('never uses the ASSIGN call (billing_save_items.php) — it adds a line rather than editing one', async () => {
    await run();
    expect(mockPost.mock.calls.map((c) => c[0])).not.toContain('/php_functions/billing_save_items.php');
  });

  it('stops at the draft when the result does not match the payment portal', async () => {
    margins = [{ idx: 124, revenue: 300 }];         // the portal worked the hire out on different figures
    await expect(run()).rejects.toThrow('the payment portal worked this hire out at £304.29');
  });

  it('a later invoice on an EU job is split but not compared with the portal (that figure was for the whole hire)', async () => {
    margins = [{ idx: 124, revenue: 9999 }];
    expect(await run(rep(), false)).toBe('split');
    expect(mockGet.mock.calls.some((c) => c[0] === '/php_functions/job_margins.php')).toBe(false);
  });

  it('31+ days: vehicle lines are zero-rated at full price; backline is split; delivery is left alone', async () => {
    job = { start: '2026-06-01T09:00:00Z', end: '2026-07-06T09:00:00Z' };   // 35 days, 30 outside the UK
    supply = [
      { ID: 500, kind: 2, title: 'Panel van', ACC_NOMINAL: 30, CATEGORY_ID: 369 },
      backline(501),
      { ID: 502, kind: 4, title: 'Delivery to Dover', ACC_NOMINAL: 40, CATEGORY_ID: 500 },
      trigger(30),
    ];
    margins = [{ idx: 130, revenue: 1000 }, { idx: 124, revenue: 350 }, { idx: 140, revenue: 100 }];
    lines = [jobLine(500, 1000, 243), jobLine(501, 350, 175), jobLine(502, 100, 178)];
    expect(await run()).toBe('split');
    expect(lines.find((l) => l.MAIN_ID === 500)).toMatchObject({ PRICE: 1000, ACC_TAX_RATE_ID: 33, VAT: 0 });
    expect(lines.find((l) => l.MAIN_ID === 502)).toMatchObject({ PRICE: 100, ACC_TAX_RATE_ID: 20, VAT: 20 });
    expect(lines.filter((l) => l.KIND === 3).map((l) => [l.DESCRIPTION, l.PRICE])).toEqual([
      ['Backline hire, UK days (5 of 35)', 50],
      ['Backline hire, non-UK days, zero-rated (HMRC 741A) (30 of 35)', 300],
    ]);
    // Portal: van 0%, backline 5/35 at 20% (£10), delivery 20% (£20) → £1,480.00.
    expect(draftRow().debit).toBe(1480);
  });
});

describe('planEuSplit', () => {
  const names = () => 'Backline hire';
  it('refuses a line it cannot match to the job, and a custom line already on the draft', () => {
    const lineX = { ID: 1, MAIN_ID: 9, KIND: 2, PRICE: 10, ACC_NOMINAL_ID: 175 };
    expect(planEuSplit({ lines: [lineX], classOf: () => null, nominalName: names, hireDays: 10, nonUkDays: 5 }))
      .toEqual({ problem: expect.stringContaining("can't match") });
    const custom = { ID: 2, MAIN_ID: 0, KIND: 3, PRICE: 10, DESCRIPTION: 'Something', ACC_NOMINAL_ID: 175 };
    expect(planEuSplit({ lines: [custom], classOf: () => 'equipment', nominalName: names, hireDays: 10, nonUkDays: 5 }))
      .toEqual({ problem: expect.stringContaining('custom line') });
  });

  it('every day outside the UK: one zero-rated line only', () => {
    const l = { ID: 1, MAIN_ID: 9, KIND: 2, PRICE: 100, ACC_NOMINAL_ID: 175 };
    const r = planEuSplit({ lines: [l], classOf: () => 'equipment', nominalName: names, hireDays: 7, nonUkDays: 9 }) as any;
    expect(r.plan.custom).toEqual([expect.objectContaining({ amount: 100, taxId: 33, description: 'Backline hire, non-UK days, zero-rated (HMRC 741A) (7 of 7)' })]);
  });
});
