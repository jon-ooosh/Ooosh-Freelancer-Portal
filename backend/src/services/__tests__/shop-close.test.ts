/**
 * The weekly close (SHOP-SALES-SPEC.md §20) against a small fake of HireHop.
 *
 * What matters most: it stops at the DRAFT when the pennies don't agree (a
 * draft never reaches Xero), it never raises a second invoice or allocates a
 * payment twice when resumed, and every payment is allocated from its OWN
 * bank to the invoice it created.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
  hhBroker: { post: jest.fn(), get: jest.fn() },
}));
jest.mock('../hh-deposit-release', () => ({
  ...jest.requireActual('../hh-deposit-release'),
  readBillingRows: jest.fn(),
}));
jest.mock('../hh-xero-sync', () => ({
  syncSavedRowToXero: jest.fn(),
  sendXeroSyncFailedAlert: jest.fn(),
}));
jest.mock('../shop-drain', () => ({ withShopDrainLock: (fn: () => unknown) => fn() }));
jest.mock('../shop-reconcile', () => ({
  SHOP_ALERT_RECIPIENT: 'jon@example.test',
  checkShopPeriodLocked: jest.fn(),
}));
jest.mock('../shop-stock', () => ({ hhLocalNow: () => '2026-09-28 09:00:00' }));
jest.mock('../email-service', () => ({ emailService: { sendRaw: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../config/app-urls', () => ({ getFrontendUrl: () => 'https://op.test' }));

import { query } from '../../config/database';
import hhBroker from '../hirehop-broker';
import { readBillingRows } from '../hh-deposit-release';
import { syncSavedRowToXero } from '../hh-xero-sync';
import { checkShopPeriodLocked } from '../shop-reconcile';
import { emailService } from '../email-service';
import { runShopClose } from '../shop-close';

const mockQuery = query as jest.Mock;
const mockPost = (hhBroker as any).post as jest.Mock;
const mockGet = (hhBroker as any).get as jest.Mock;
const mockRead = readBillingRows as jest.Mock;
const mockSync = syncSavedRowToXero as jest.Mock;
const mockCheck = checkShopPeriodLocked as jest.Mock;
const mockEmail = (emailService as any).sendRaw as jest.Mock;

// ── A tiny HireHop ──────────────────────────────────────────────────────

interface Dep { id: number; credit: number; bank: number; allocated: number }
interface Inv { id: number; status: number; number: string; net: number; tax: number; paid: number; accId: string }

let hh: { jobStatus: number; invoices: Inv[]; deposits: Dep[]; nextApp: number; draftNet: number; draftTax: number };

function rows() {
  const out: any[] = [];
  for (const i of hh.invoices) {
    const gross = Math.round((i.net + i.tax) * 100) / 100;
    out.push({
      kind: 1, status: String(i.status), debit: gross, owing: Math.round((gross - i.paid) * 100) / 100,
      data: { ID: i.id, NUMBER: i.number, STATUS: i.status, NET: i.net, TAX: i.tax, ACC_ID: i.accId },
    });
  }
  for (const d of hh.deposits) {
    out.push({
      kind: 6, credit: d.credit, owing: -(d.credit - d.allocated), paid: d.allocated,
      data: { ID: d.id, ACC_ACCOUNT_ID: d.bank, DESCRIPTION: '16757 - shop sale' },
    });
  }
  return out;
}

function installHireHop() {
  mockRead.mockImplementation(async () => rows());
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/api/job_data.php') return { success: true, data: { STATUS: hh.jobStatus } };
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (path: string, body: any) => {
    if (path === '/php_functions/billing_save.php') {
      const inv: Inv = { id: 12900, status: 0, number: '', net: hh.draftNet, tax: hh.draftTax, paid: 0, accId: '' };
      hh.invoices.push(inv);
      return { success: true, data: { rows: [{ kind: 1, data: { ID: inv.id } }] } };
    }
    if (path === '/php_functions/billing_save_status.php') {
      const inv = hh.invoices.find((i) => i.id === body.id)!;
      inv.status = 2; inv.number = 'OT-INV-99001';
      return { success: true, data: { hh_task: 'post_invoice_credit', hh_id: inv.id, hh_acc_package_id: 3, hh_package_type: 1 } };
    }
    if (path === '/php_functions/billing_payments_save.php') {
      const dep = hh.deposits.find((d) => d.id === body.deposit)!;
      const inv = hh.invoices.find((i) => i.id === body.OWNER)!;
      dep.allocated += body.paid; inv.paid += body.paid;
      return { success: true, data: { hh_task: 'post_payment', hh_id: hh.nextApp++ } };
    }
    if (path === '/frames/status_save.php') { hh.jobStatus = body.status; return { success: true, data: {} }; }
    throw new Error(`unexpected POST ${path}`);
  });
  mockSync.mockImplementation(async (_label: string, saved: any) => {
    if (saved.hh_task === 'post_invoice_credit') {
      const inv = hh.invoices.find((i) => i.id === saved.hh_id);
      if (inv) inv.accId = 'xero-guid';
    }
    return { ok: true, error: null };
  });
}

// ── A tiny OP ───────────────────────────────────────────────────────────

let period: any;
let expected: { gross: number; net: number; lines: number };
let unfinished: number;

function installDb() {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM shop_sale_periods WHERE id = $1')) return { rows: [{ ...period }] };
    if (sql.includes('close_log = COALESCE')) {
      period.close_log = [...period.close_log, ...JSON.parse(params[1])];
      return { rows: [] };
    }
    if (sql.includes("SET hh_invoice_id = $2, close_state = 'drafted'")) {
      period.hh_invoice_id = params[1]; period.close_state = 'drafted'; return { rows: [] };
    }
    if (sql.includes('SET hh_invoice_id = NULL, close_state = NULL')) {
      period.hh_invoice_id = null; period.close_state = null; return { rows: [] };
    }
    if (sql.includes("SET hh_invoice_number = $2, close_state = 'approved'")) {
      period.hh_invoice_number = params[1]; period.close_state = 'approved'; return { rows: [] };
    }
    if (sql.includes('SET close_state = $2')) { period.close_state = params[1]; return { rows: [] }; }
    if (sql.includes("SET close_state = 'completed'")) {
      period.close_state = 'completed'; period.closed_at = 'now'; period.closed_by = params[1]; return { rows: [] };
    }
    if (sql.includes('SUM(l.line_gross)')) return { rows: [expected] };
    if (sql.includes('COUNT(*) AS n')) return { rows: [{ n: unfinished }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  hh = {
    jobStatus: 5, invoices: [], nextApp: 500,
    deposits: [
      { id: 9401, credit: 5.00, bank: 168, allocated: 0 },    // Till (cash)
      { id: 9402, credit: 7.00, bank: 169, allocated: 0 },    // Worldpay
    ],
    draftNet: 10.00, draftTax: 2.00,
  };
  period = {
    id: 'p1', period_start: '2020-01-06', period_end: '2020-01-12', hh_job_number: 16757,
    hh_invoice_id: null, hh_invoice_number: null, close_state: null, close_log: [], closed_at: null,
  };
  expected = { gross: 12.00, net: 10.00, lines: 3 };
  unfinished = 0;
  mockCheck.mockResolvedValue({ problems: [], status: 5 });
  installHireHop();
  installDb();
});

const posts = (path: string) => mockPost.mock.calls.filter((c) => c[0] === path).map((c) => c[1]);

describe('runShopClose', () => {
  it('closes a clean week end to end', async () => {
    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(true);
    expect(period.close_state).toBe('completed');
    expect(period.hh_invoice_number).toBe('OT-INV-99001');

    // Draft: ALWAYS all: 1, on the right job.
    const [draft] = posts('/php_functions/billing_save.php');
    expect(draft).toMatchObject({ id: 0, all: 1, job: 16757 });

    // Approved, dated the week's Sunday.
    const [approve] = posts('/php_functions/billing_save_status.php');
    expect(approve).toMatchObject({ id: 12900, status: 2, type: 1, date: '2020-01-12 23:59:00' });

    // Invoice pushed to Xero as an invoice, not a payment.
    expect(mockSync.mock.calls[0][1]).toMatchObject({ hh_task: 'post_invoice_credit', hh_id: 12900 });

    // Each payment allocated IN FULL from its OWN bank.
    const allocs = posts('/php_functions/billing_payments_save.php');
    expect(allocs).toEqual([
      expect.objectContaining({ id: 0, OWNER: 12900, deposit: 9401, bank: 168, paid: 5, no_webhook: 1 }),
      expect.objectContaining({ id: 0, OWNER: 12900, deposit: 9402, bank: 169, paid: 7, no_webhook: 1 }),
    ]);

    expect(hh.jobStatus).toBe(11);
    expect(hh.invoices).toHaveLength(1);
  });

  it('stops at the DRAFT when the invoice is a penny out — nothing approved, jon emailed', async () => {
    hh.draftTax = 2.01;                        // HireHop's VAT rounding disagrees

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(false);
    expect(r.message).toContain('£12.01');
    expect(period.close_state).toBe('drafted');
    expect(posts('/php_functions/billing_save_status.php')).toHaveLength(0);
    expect(posts('/php_functions/billing_payments_save.php')).toHaveLength(0);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(r.message).toContain('VAT rounding');      // ex-VAT agreed, so say so
  });

  it('resumes a stopped draft without raising a second invoice', async () => {
    hh.draftTax = 2.01;
    await runShopClose('p1', 'user-jon');
    hh.invoices[0].tax = 2.00;                 // fixed by hand

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toHaveLength(1);
    expect(hh.invoices).toHaveLength(1);
  });

  it('starts again cleanly once a stopped draft is deleted in HireHop', async () => {
    hh.draftTax = 2.01;
    await runShopClose('p1', 'user-jon');
    hh.invoices = [];                          // jon deletes the draft
    hh.draftTax = 2.00;

    const first = await runShopClose('p1', 'user-jon');
    expect(first.done).toBe(false);
    expect(period.close_state).toBeNull();
    expect(period.hh_invoice_id).toBeNull();

    const second = await runShopClose('p1', 'user-jon');
    expect(second.done).toBe(true);
  });

  it('on resume, only allocates payments that still hold money', async () => {
    // Approved and in Xero; 9401 was allocated before a Xero wobble stopped it.
    hh.invoices = [{ id: 12900, status: 2, number: 'OT-INV-99001', net: 10, tax: 2, paid: 5, accId: 'xero-guid' }];
    hh.deposits[0].allocated = 5;
    Object.assign(period, { hh_invoice_id: 12900, hh_invoice_number: 'OT-INV-99001', close_state: 'approved' });

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(true);
    const allocs = posts('/php_functions/billing_payments_save.php');
    expect(allocs).toHaveLength(1);
    expect(allocs[0]).toMatchObject({ deposit: 9402, paid: 7, bank: 169 });
    expect(posts('/php_functions/billing_save.php')).toHaveLength(0);
  });

  it('never approves twice — resuming after an approve whose read-back failed', async () => {
    // HireHop approved it, but OP stopped before recording that.
    hh.invoices = [{ id: 12900, status: 2, number: 'OT-INV-99001', net: 10, tax: 2, paid: 0, accId: '' }];
    Object.assign(period, { hh_invoice_id: 12900, close_state: 'drafted' });

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save_status.php')).toHaveLength(0);
    expect(mockSync.mock.calls[0][1]).toMatchObject({ hh_task: 'post_invoice_credit', hh_id: 12900 });
    expect(period.hh_invoice_number).toBe('OT-INV-99001');
  });

  it("does not allocate anything if Xero refuses the invoice", async () => {
    mockSync.mockResolvedValueOnce({ ok: false, error: 'Xero said no' });

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(false);
    expect(period.close_state).toBe('approved');
    expect(posts('/php_functions/billing_payments_save.php')).toHaveLength(0);
    expect(r.message).toContain('Xero said no');
  });

  it('refuses to start while a sale from the week is still queued', async () => {
    unfinished = 1;
    const r = await runShopClose('p1', 'user-jon');
    expect(r.done).toBe(false);
    expect(r.preview.blockers.join(' ')).toContain("hasn't reached HireHop");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses to start on a job that already has an invoice', async () => {
    hh.invoices = [{ id: 11111, status: 2, number: 'OT-INV-1', net: 10, tax: 2, paid: 0, accId: 'x' }];
    const r = await runShopClose('p1', 'user-jon');
    expect(r.done).toBe(false);
    expect(r.preview.blockers.join(' ')).toContain('OT-INV-1');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses to start before the week is over", async () => {
    Object.assign(period, { period_start: '2999-01-07', period_end: '2999-01-13' });
    const r = await runShopClose('p1', 'user-jon');
    expect(r.done).toBe(false);
    expect(r.preview.blockers.join(' ')).toContain("isn't over");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes an empty week with no invoice', async () => {
    expected = { gross: 0, net: 0, lines: 0 };
    hh.deposits = [];

    const r = await runShopClose('p1', 'user-jon');

    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toHaveLength(0);
    expect(hh.jobStatus).toBe(11);
    expect(period.close_state).toBe('completed');
  });
});
