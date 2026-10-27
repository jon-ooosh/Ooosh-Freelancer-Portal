/**
 * The hire close-out's Phase 1 (docs/HIRE-CLOSE-OUT-SPEC.md §4.3–§6) against a
 * small fake of HireHop, Xero and OP.
 *
 * What matters most: the plan never allocates an EXCESS deposit; it refuses
 * when HireHop and OP disagree about a payment or a refund (the job-16015
 * check); every HireHop write is read back; Xero is applied for every
 * allocation on the invoice, including ones made by hand; a part-paid invoice
 * is an expected state, not a stop; Complete refuses while anything is owed,
 * held or unallocated, and excess held is an override, not a gate.
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
jest.mock('../hh-xero-sync', () => ({ syncSavedRowToXero: jest.fn(), sendXeroSyncFailedAlert: jest.fn() }));
jest.mock('../vat-adjustment', () => ({ hasNonStandardVatItem: jest.fn() }));
jest.mock('../../routes/webhooks', () => ({ handleJobStatusChange: jest.fn().mockResolvedValue({ success: true, message: 'ok' }) }));
jest.mock('../hh-deposit', () => ({
  getMethodForBankId: (id: number) => ({ 267: 'stripe_gbp', 169: 'worldpay' } as Record<number, string>)[id] || 'worldpay',
  PAYMENT_METHODS_LABELS: { stripe_gbp: 'Stripe GBP', worldpay: 'Worldpay' },
}));
jest.mock('../shop-stock', () => ({ hhLocalNow: () => '2026-10-09 09:00:00' }));
jest.mock('../../config/xero', () => ({ isXeroConfigured: () => true }));
jest.mock('../xero-broker', () => ({
  __esModule: true,
  default: { getInvoice: jest.fn(), getInvoices: jest.fn().mockResolvedValue([]), getOverpayment: jest.fn(), allocateOverpayment: jest.fn() },
}));
jest.mock('../eu-vat-split', () => ({ splitEuDraft: jest.fn() }));

import { query } from '../../config/database';
import hhBroker from '../hirehop-broker';
import { readBillingRows } from '../hh-deposit-release';
import xeroBroker from '../xero-broker';
import { syncSavedRowToXero } from '../hh-xero-sync';
import { hasNonStandardVatItem } from '../vat-adjustment';
import { planHireCloseOut, runHireAllocation, completeHireJob, raiseHireInvoice, runHireCloseOut, planAllocations, setPaymentTarget } from '../hire-close-out';
import { handleJobStatusChange } from '../../routes/webhooks';
import { allocateOnArrival, fireArrivalHook } from '../close-out-arrival';
import { splitEuDraft } from '../eu-vat-split';
import { Stop } from '../hh-invoice-close';
const mockSplit = splitEuDraft as jest.Mock;
const mockStatus = handleJobStatusChange as jest.Mock;
const mockSync = syncSavedRowToXero as jest.Mock;
const mockEu = hasNonStandardVatItem as jest.Mock;

const mockQuery = query as jest.Mock;
const mockPost = (hhBroker as any).post as jest.Mock;
const mockGet = (hhBroker as any).get as jest.Mock;
const mockRead = readBillingRows as jest.Mock;
const mockXeroInvoice = (xeroBroker as any).getInvoice as jest.Mock;
const mockXeroOverpayment = (xeroBroker as any).getOverpayment as jest.Mock;
const mockXeroAllocate = (xeroBroker as any).allocateOverpayment as jest.Mock;

// ── A tiny HireHop ──────────────────────────────────────────────────────

interface Dep { id: number; credit: number; bank: number; allocated: number; desc: string; date: string; noXero?: boolean }
interface Inv { id: number; status: number; number: string; gross: number; paid: number; accId: string; date: string; desc?: string; items?: any[] }
interface App { id: number; invoiceId: number; depositId: number; amount: number; desc?: string }

let hh: {
  jobStatus: number; invoices: Inv[]; deposits: Dep[]; apps: App[]; nextApp: number; ignoreAllocations: boolean;
  /** HireHop's quoted net (kind 0) and the net of lines not yet on any invoice. */
  accruedNet: number; uninvoicedNet: number; euTrigger: boolean; nextInvoice: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function rows(): any[] {
  const out: any[] = [];
  out.push({ kind: 0, accrued: hh.accruedNet, data: { TYPE: 0, TOTAL: hh.accruedNet } });
  for (const i of hh.invoices) {
    out.push({
      kind: 1, status: String(i.status), debit: i.gross, owing: r2(i.gross - i.paid), date: i.date,
      data: { ID: i.id, NUMBER: i.number, STATUS: i.status, NET: r2(i.gross / 1.2), TAX: r2(i.gross - i.gross / 1.2), ACC_ID: i.accId, TAX_POINT: i.date, DESCRIPTION: i.desc || '', ...(i.items ? { items: i.items.map((l) => ({ ...l })) } : {}) },
    });
  }
  for (const d of hh.deposits) {
    out.push({
      kind: 6, credit: d.credit, owing: -(r2(d.credit - d.allocated)), paid: d.allocated, date: d.date,
      data: { ID: d.id, ACC_ACCOUNT_ID: d.bank, DESCRIPTION: d.desc, DATE: d.date, ACC_DATA: d.noXero ? {} : { OverpaymentID: `op-${d.id}` } },
    });
  }
  for (const a of hh.apps) {
    // Dual-published: deposit-side (credit < 0) and, when there is an invoice, the invoice-side twin.
    out.push({ kind: 3, credit: -a.amount, date: '2026-09-25', data: { ID: a.id, OWNER: a.invoiceId, OWNER_DEPOSIT: a.depositId, parent_is: 'deposit', DESCRIPTION: a.desc || '', DATE: '2026-09-25' } });
    if (a.invoiceId > 0) {
      out.push({ kind: 3, credit: a.amount, data: { ID: a.id, OWNER: a.invoiceId, OWNER_DEPOSIT: a.depositId, AMOUNT: a.amount, parent_is: 'invoice', DESCRIPTION: a.desc || '' } });
    }
  }
  (out as any).banks = [{ ID: 169, NAME: 'Worldpay' }, { ID: 267, NAME: 'Stripe GBP' }];
  return out;
}

function installHireHop() {
  mockRead.mockImplementation(async () => rows());
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/api/job_data.php') return { success: true, data: { STATUS: hh.jobStatus } };
    if (path === '/frames/items_to_supply_list.php') return { success: true, data: supply };
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (path: string, body: any) => {
    if (path === '/php_functions/billing_save.php' && body.all === 0) {
      // all: 0 — an EMPTY draft, for the supply list to be pasted onto (§10.7).
      const inv: Inv = { id: hh.nextInvoice++, status: 0, number: '', gross: 0, paid: 0, accId: '', date: '2026-10-13', items: [] };
      hh.invoices.push(inv);
      return { success: true, data: { rows: [{ kind: 1, data: { ID: inv.id } }] } };
    }
    if (path === '/php_functions/billing_paste.php') {
      // HireHop puts each grid row on the invoice as a line pointing at the job line (MAIN_ID).
      const inv = hh.invoices.find((i) => i.id === body.bill)!;
      for (let i = 0; body[`data[${i}][ID]`] !== undefined; i++) {
        if (pasteDrops === body[`data[${i}][ID]`]) continue;
        const kind = body[`data[${i}][kind]`];
        inv.items!.push({ ID: 105000 + i, KIND: kind, MAIN_ID: kind === 0 ? 0 : body[`data[${i}][ID]`], PRICE: body[`data[${i}][inv_PRICE]`], LFT: body[`data[${i}][LFT]`] });
      }
      const net = r2(inv.items!.reduce((t, l) => t + l.PRICE, 0));
      inv.gross = r2(net * 1.2); hh.uninvoicedNet = r2(hh.uninvoicedNet - net);
      return { success: true, data: {} };
    }
    if (path === '/php_functions/billing_save.php') {
      // all: 1 — a draft from every line not yet invoiced (proven 9 Oct 2026).
      const net = hh.uninvoicedNet;
      const inv: Inv = { id: hh.nextInvoice++, status: 0, number: '', gross: r2(net * 1.2), paid: 0, accId: '', date: '2026-10-09' };
      hh.invoices.push(inv); hh.uninvoicedNet = 0;
      return { success: true, data: { rows: [{ kind: 1, data: { ID: inv.id } }] } };
    }
    if (path === '/php_functions/billing_save_item.php' && body.id === 0) {
      // A custom line (§10.3b) — the cancellation fee. Lines are priced net; the fake's VAT is 20%.
      const inv = hh.invoices.find((i) => i.id === body.bill)!;
      inv.items!.push({ ID: 106000 + inv.items!.length, KIND: 3, MAIN_ID: 0, DESCRIPTION: body.note, PRICE: body.total, ACC_TAX_RATE_ID: body.vat_id, ACC_NOMINAL_ID: body.nominal_id });
      inv.gross = r2(inv.items!.reduce((t, l) => t + l.PRICE, 0) * 1.2);
      return { success: true, data: {} };
    }
    if (path === '/php_functions/billing_save_status.php') {
      const inv = hh.invoices.find((i) => i.id === body.id)!;
      inv.status = 2; inv.number = `OT-INV-${inv.id}`;
      return { success: true, data: { hh_task: 'post_invoice_credit', hh_id: inv.id, hh_acc_package_id: 3, hh_package_type: 1 } };
    }
    if (path === '/php_functions/billing_payments_save.php') {
      if (hh.ignoreAllocations) return { success: true, data: {} };   // "success" that did nothing (§0)
      const dep = hh.deposits.find((d) => d.id === body.deposit)!;
      const inv = hh.invoices.find((i) => i.id === body.OWNER)!;
      dep.allocated = r2(dep.allocated + body.paid); inv.paid = r2(inv.paid + body.paid);
      hh.apps.push({ id: hh.nextApp++, invoiceId: inv.id, depositId: dep.id, amount: body.paid });
      return { success: true, data: { hh_task: 'post_payment', hh_id: hh.nextApp - 1 } };
    }
    if (path === '/frames/status_save.php') { hh.jobStatus = body.status; return { success: true, data: {} }; }
    throw new Error(`unexpected POST ${path}`);
  });
}

// ── A tiny Xero — every deposit is an UNAPPLIED overpayment, every invoice awaiting payment (as live, 9 Oct 2026)

interface Op { remaining: number; allocations: Array<{ Invoice: { InvoiceID: string }; Amount: number }> }
let xero: { invoiceDue: Record<string, number>; overpayments: Record<string, Op> };

function installXero() {
  mockSync.mockImplementation(async (_label: string, saved: any) => {
    if (saved.hh_task === 'post_invoice_credit') {
      const inv = hh.invoices.find((i) => i.id === saved.hh_id);
      if (inv) { inv.accId = `x-${inv.id}`; xero.invoiceDue[inv.accId] = inv.gross; }
    }
    return { ok: true, error: null };
  });
  mockEu.mockImplementation(async () => hh.euTrigger);
  xero = {
    invoiceDue: Object.fromEntries(hh.invoices.filter((i) => i.accId).map((i) => [i.accId, i.gross])),
    overpayments: Object.fromEntries(hh.deposits.map((d) => [`op-${d.id}`, { remaining: d.credit, allocations: [] }])),
  };
  mockXeroInvoice.mockImplementation(async (id: string) => (id in xero.invoiceDue ? { InvoiceID: id, AmountDue: xero.invoiceDue[id] } : null));
  mockXeroOverpayment.mockImplementation(async (id: string) => {
    const op = xero.overpayments[id];
    return op ? { OverpaymentID: id, RemainingCredit: op.remaining, Allocations: op.allocations } : null;
  });
  mockXeroAllocate.mockImplementation(async (a: { overpaymentId: string; invoiceId: string; amount: number }) => {
    const op = xero.overpayments[a.overpaymentId];
    op.remaining = r2(op.remaining - a.amount);
    op.allocations.push({ Invoice: { InvoiceID: a.invoiceId }, Amount: a.amount });
    xero.invoiceDue[a.invoiceId] = r2(xero.invoiceDue[a.invoiceId] - a.amount);
  });
}

// ── A tiny OP ───────────────────────────────────────────────────────────

const JOB = { id: '8d4ac717-705d-4378-b640-44adb766f65c', hh_job_number: 16015, job_name: 'Headsend', is_internal: false, pipeline_status: 'returned' };
let opPayments: Array<{ hirehop_deposit_id: number; payment_type: string; amount: number; payment_method: string; source: string; notes: string | null }>;
let excessHeld: number;
/** What OP has recorded as claimed from an excess deposit (`job_excess.claim_amount`). */
let excessClaimed: number;
let logRows: any[];
let arrivalEnabled: string;
/** `closeout_invoice_layout` — 'flat' unless a test is about the quote layout. */
let layout: string;
/** The job's supply list, for the paste (headers, £0 lines and a prompt, like 16598). */
let supply: any[];
/** A job line HireHop "forgets" to paste. */
let pasteDrops: number | null;

function installDb() {
  mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM system_settings')) return { rows: [{ value: params[0] === 'closeout_invoice_layout' ? layout : arrivalEnabled }] };
    if (sql.includes('FROM jobs WHERE')) return { rows: [{ ...JOB }] };
    if (sql.includes('FROM job_payments')) return { rows: opPayments };
    if (sql.includes('FROM v_excess_held')) return { rows: [{ held: excessHeld }] };
    if (sql.includes('FROM job_excess')) return { rows: [{ claimed: excessClaimed }] };
    if (sql.includes('INSERT INTO job_closeout_log')) {
      logRows.unshift({ id: `l${logRows.length}`, step: params[1], ok: params[2], detail: params[3], hh_refs: params[4] ? JSON.parse(params[4]) : null, user_id: params[5], user_name: null, created_at: 'now' });
      return { rows: [] };
    }
    if (sql.includes('FROM job_requirements')) return { rows: [{ invoice_req_id: null, invoice_req_status: null, open_problems: 0 }] };
    if (sql.includes('FROM job_closeout_log')) return { rows: logRows };
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

/** Job 16015 as it should have been: 8661 untouched, 9091 + excess 9093 applied by hand, £254.17 owing. */
function job16015Corrected() {
  hh = {
    jobStatus: 7, nextApp: 900, ignoreAllocations: false,
    accruedNet: 5069.99, uninvoicedNet: 0, euTrigger: false, nextInvoice: 13000,
    invoices: [{ id: 12252, status: 2, number: 'OT-INV-12252', gross: 6083.99, paid: 5829.82, accId: 'x-12252', date: '2026-09-25' }],
    deposits: [
      { id: 8661, credit: 1140.97, bank: 267, allocated: 0, desc: '16015 - deposit', date: '2026-06-16' },
      { id: 9091, credit: 4629.82, bank: 267, allocated: 4629.82, desc: '16015 - deposit', date: '2026-08-24' },
      { id: 9093, credit: 1200, bank: 267, allocated: 1200, desc: '16015 - excess (Full excess - 1 van(s))', date: '2026-08-24' },
    ],
    apps: [
      { id: 902, invoiceId: 12252, depositId: 9091, amount: 4629.82 },
      { id: 903, invoiceId: 12252, depositId: 9093, amount: 1200 },
    ],
  };
  opPayments = [
    { hirehop_deposit_id: 8661, payment_type: 'deposit', amount: 1140.97, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
    { hirehop_deposit_id: 9091, payment_type: 'deposit', amount: 4629.82, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
    { hirehop_deposit_id: 9093, payment_type: 'excess', amount: 1200, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
  ];
  excessHeld = 0;
  // These tests treat 9093's £1,200 on the invoice as a claim OP knows about; the by-hand case has its own test.
  excessClaimed = 1200;
}

beforeEach(() => {
  jest.clearAllMocks();
  logRows = [];
  arrivalEnabled = 'true';
  layout = 'flat';
  pasteDrops = null;
  supply = [
    { ID: 8818, kind: 0, title: 'Vehicle', LFT: 1, RGT: 8, PRICE: 0, UNIT_PRICE: 0 },
    // As the feed sends it (16849): the price per DAY, as a string, and the number of days apart.
    { ID: '164980', kind: '2', qty: '1.00', title: 'Premium LWB Splitter Van', LFT: '2', RGT: '5', PRICE: '250.000000', UNIT_PRICE: '250.000000', MULTIPLIER: 2,
      ACC_NOMINAL: null, DURATION: null, TYPE_CUSTOM_FIELDS: { preptimemins: 60 } },
    { ID: 18340, kind: 3, qty: 1, title: '↑ Rear seats arranged around a table', LFT: 3, RGT: 4, PRICE: 0, UNIT_PRICE: 0 },
    { ID: 169041, kind: 2, qty: 1, title: '▶ Cost / fee / recharge', LFT: 6, RGT: 7, PRICE: 10, UNIT_PRICE: 10 },
  ];
  job16015Corrected();
  installHireHop();
  installXero();
  installDb();
});

const posts = (path: string) => mockPost.mock.calls.filter((c) => c[0] === path).map((c) => c[1]);

describe('planAllocations (the §5 rule)', () => {
  const inv = (invoiceId: number, owing: number, date: string) => ({ invoiceId, number: `INV-${invoiceId}`, status: 2, date, gross: owing, owing, inXero: true, xeroId: 'x', chargeOnly: false });
  const pay = (depositId: number, available: number, date: string) => ({ depositId, bankId: 267, bankName: null, description: '', date, credit: available, available });

  it('spreads deposits across invoices oldest first and reports surplus and shortfall', () => {
    const r = planAllocations([inv(1, 1800, '2026-01-01'), inv(2, 1500, '2026-02-01')], [pay(10, 3000, '2026-01-01')]);
    expect(r.allocations).toEqual([
      expect.objectContaining({ depositId: 10, invoiceId: 1, amount: 1800 }),
      expect.objectContaining({ depositId: 10, invoiceId: 2, amount: 1200 }),
    ]);
    expect(r.surplus).toEqual([]);
    expect(r.shortfall).toBe(300);
  });

  it('leaves the rest of a deposit as surplus', () => {
    const r = planAllocations([inv(1, 254.17, '2026-09-25')], [pay(8661, 1140.97, '2026-06-16')]);
    expect(r.allocations).toEqual([expect.objectContaining({ amount: 254.17 })]);
    expect(r.surplus).toEqual([{ depositId: 8661, amount: 886.8 }]);
    expect(r.shortfall).toBe(0);
  });
});

describe('planHireCloseOut', () => {
  it('16015 corrected: allocates £254.17 from the first deposit, surfaces £886.80 surplus, never the excess', async () => {
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.allocations).toEqual([expect.objectContaining({ depositId: 8661, amount: 254.17, invoiceId: 12252 })]);
    expect(plan.surplus).toEqual([{ depositId: 8661, amount: 886.8 }]);
    expect(plan.payments.map((p) => p.depositId)).toEqual([8661]);          // 9093 (excess) excluded, 9091 holds nothing
    expect(plan.payments[0].bankName).toBe('Stripe GBP');
    expect(plan.sentences.join(' ')).toContain('Leave £886.80');
  });

  it('16015 as it really was: an excess applied by hand (OP recorded no claim) blocks, naming the deposit', async () => {
    excessClaimed = 0;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.join(' ')).toContain('Excess payment 9093 has £1200.00 applied to invoices in HireHop, but OP has recorded only £0.00');
    // Nothing left on the excess → Claim is the only way OP can record it.
    expect(plan.blockers.join(' ')).toContain('remove the allocation in HireHop and use Excess → Claim');
    expect(plan.blockers.join(' ')).not.toContain('Retained by Ooosh');
    const run = await runHireAllocation(JOB.id, 'u1');
    expect(run.done).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('16491: part of the excess applied by hand, the rest still free → Reimburse what HireHop holds + "Retained by Ooosh"', async () => {
    excessClaimed = 0;
    hh.deposits[2].allocated = 841.32;              // £358.68 of the £1,200 still on payment 9093
    hh.apps[1].amount = 841.32;
    hh.invoices[0].paid = 4629.82 + 841.32;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.ready).toBe(false);
    const said = plan.blockers.join(' ');
    expect(said).toContain('Excess payment 9093 has £841.32 applied to invoices in HireHop, but OP has recorded only £0.00');
    expect(said).toContain('Reimburse for £358.68');
    expect(said).toContain('"Retained by Ooosh"');
    expect(said).toContain('Nothing is applied in Xero until the two agree.');
  });

  it('16015 as HireHop had it: a blank, un-recorded refund row is a blocker that names the fix', async () => {
    hh.deposits[0].allocated = 1140.97;
    hh.apps.push({ id: 901, invoiceId: 0, depositId: 8661, amount: 1140.97 });   // OWNER 0, blank description
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.ready).toBe(false);
    expect(plan.blockers.join(' ')).toContain('£1140.97 refunded from payment 8661'.replace('£1140.97', '£1140.97'));
    expect(plan.blockers.join(' ')).toContain('delete that payment row in HireHop');
    expect(plan.allocations).toEqual([]);
    expect(plan.shortfall).toBe(254.17);
  });

  it('a refund OP itself recorded is fine', async () => {
    hh.deposits[0].allocated = 1140.97;
    hh.apps.push({ id: 901, invoiceId: 0, depositId: 8661, amount: 1140.97, desc: '16015 - Refund (deposit)' });
    opPayments.push({ hirehop_deposit_id: 8661, payment_type: 'refund', amount: 1140.97, payment_method: 'stripe_gbp', source: 'op', notes: null });
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('a HireHop deposit OP never recorded is a blocker', async () => {
    opPayments = opPayments.filter((p) => p.hirehop_deposit_id !== 8661);
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers.join(' ')).toContain('Payment 8661');
    expect(plan.blockers.join(' ')).toContain('OP has no record');
  });

  it('a deposit whose amount differs between HireHop and OP is a blocker', async () => {
    opPayments[0].amount = 1140.0;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers.join(' ')).toContain('£1140.97 in HireHop but £1140.00 in OP');
  });

  it('refuses when there is no approved invoice', async () => {
    hh.invoices[0].status = 0;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers.join(' ')).toContain('Raise the invoice first');
  });

  it('two invoices owing: asks which one the hire payments go to, and allocates nothing until told', async () => {
    hh.invoices.push({ id: 12300, status: 2, number: 'OT-INV-12300', gross: 120, paid: 0, accId: 'x-12300', date: '2026-10-01' });
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers.join(' ')).toContain('2 invoices are owing (OT-INV-12252, OT-INV-12300) — choose which one the hire payments go to');
    expect(plan.paymentTarget).toBeNull();
    expect(plan.allocations).toEqual([]);
  });

  it('once a manager chooses, the hire payments go to that invoice ONLY — the other (damage) is left alone', async () => {
    hh.invoices.push({ id: 12300, status: 2, number: 'OT-INV-12300', gross: 120, paid: 0, accId: 'x-12300', date: '2026-10-01' });
    const plan = await setPaymentTarget(JOB.id, 'u1', 12252);
    expect(plan.paymentTarget).toEqual({ invoiceId: 12252, number: 'OT-INV-12252' });
    expect(plan.blockers.join(' ')).not.toContain('invoices are owing');
    // 8661 holds £1,140.97: £254.17 to the chosen invoice, the rest left — none of it spills onto OT-INV-12300.
    expect(plan.allocations).toEqual([expect.objectContaining({ depositId: 8661, amount: 254.17, invoiceId: 12252 })]);
    expect(plan.surplus).toEqual([{ depositId: 8661, amount: 886.8 }]);
    expect(plan.shortfall).toBe(120);
    expect(plan.sentences.join(' ')).toContain('OT-INV-12300 (£120.00 owing) takes no hire payments');
    // Changing the choice: the newest wins.
    const again = await setPaymentTarget(JOB.id, 'u1', 12300);
    expect(again.allocations).toEqual([expect.objectContaining({ depositId: 8661, amount: 120, invoiceId: 12300 })]);
  });

  it('refuses to point the hire payments at an invoice that is not owing', async () => {
    await expect(setPaymentTarget(JOB.id, 'u1', 99999)).rejects.toThrow('not owing');
  });

  it('warns about excess still held and never allocates the excess deposit', async () => {
    hh.deposits[2].allocated = 0; hh.apps = hh.apps.filter((a) => a.depositId !== 9093);
    hh.invoices[0].paid = 4629.82;
    excessHeld = 1200;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.warnings.join(' ')).toContain('£1200.00 excess is still held');
    expect(plan.allocations.map((a) => a.depositId)).toEqual([8661]);
    expect(plan.payments.map((p) => p.depositId)).toEqual([8661]);
  });

  it('refuses to allocate a payment that never reached Xero', async () => {
    hh.deposits[0].noXero = true;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.blockers.join(' ')).toContain("isn't in Xero as a payment");
  });

  it('says so when a job has not returned yet, but does not block', async () => {
    hh.jobStatus = 5;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.warnings.join(' ')).toContain("hasn't returned yet");
    expect(plan.ready).toBe(true);
  });
});

describe('runHireAllocation', () => {
  it('16015 corrected: allocates in HireHop, applies EVERY allocation in Xero (including the hand-made ones), reads both back', async () => {
    const r = await runHireAllocation(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([
      expect.objectContaining({ deposit: 8661, OWNER: 12252, paid: 254.17, bank: 267, id: 0 }),
    ]);
    // HireHop: invoice settled, 8661 holds the surplus.
    expect(r2(hh.invoices[0].gross - hh.invoices[0].paid)).toBe(0);
    expect(r2(hh.deposits[0].credit - hh.deposits[0].allocated)).toBe(886.8);
    // Xero: the two by-hand allocations AND the new one were applied; invoice paid.
    const applied = mockXeroAllocate.mock.calls.map((c) => c[0]);
    expect(applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ overpaymentId: 'op-9091', amount: 4629.82 }),
      expect.objectContaining({ overpaymentId: 'op-9093', amount: 1200 }),
      expect.objectContaining({ overpaymentId: 'op-8661', amount: 254.17 }),
    ]));
    expect(xero.invoiceDue['x-12252']).toBe(0);
    expect(xero.overpayments['op-8661'].remaining).toBe(886.8);
    expect(r.message).toContain('£886.80 is unallocated');
    expect(r.plan.readyToComplete).toBe(false);
    expect(r.plan.surplus).toEqual([{ depositId: 8661, amount: 886.8 }]);
  });

  it('a part-paid invoice is an expected state: allocates everything, Xero matches HireHop, client still owes', async () => {
    hh.deposits[0].credit = 100; opPayments[0].amount = 100; xero.overpayments['op-8661'].remaining = 100;
    const r = await runHireAllocation(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(r2(hh.invoices[0].gross - hh.invoices[0].paid)).toBe(154.17);
    expect(xero.invoiceDue['x-12252']).toBe(154.17);
    expect(r.message).toContain('still owes £154.17');
    expect(r.plan.readyToComplete).toBe(false);
  });

  it('stops, and touches Xero not at all, when HireHop says success but nothing moved', async () => {
    hh.ignoreAllocations = true;
    const r = await runHireAllocation(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('HireHop did not allocate £254.17 of payment 8661');
    expect(mockXeroAllocate).not.toHaveBeenCalled();
    expect(logRows[0]).toMatchObject({ step: 'allocate_hh', ok: false });
  });

  it('refuses at pre-flight on a blocker and writes nothing', async () => {
    opPayments = opPayments.filter((p) => p.hirehop_deposit_id !== 8661);
    const r = await runHireAllocation(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([]);
    expect(mockXeroAllocate).not.toHaveBeenCalled();
    expect(logRows[0]).toMatchObject({ step: 'preflight', ok: false });
  });

  it('with nothing to allocate still applies the hand-made allocations in Xero', async () => {
    hh.deposits[0].allocated = 1140.97;
    hh.apps.push({ id: 901, invoiceId: 0, depositId: 8661, amount: 1140.97, desc: '16015 - Refund (deposit)' });
    opPayments.push({ hirehop_deposit_id: 8661, payment_type: 'refund', amount: 1140.97, payment_method: 'stripe_gbp', source: 'op', notes: null });
    const r = await runHireAllocation(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([]);
    expect(mockXeroAllocate).toHaveBeenCalledTimes(2);
    expect(xero.invoiceDue['x-12252']).toBe(254.17);
    expect(r.message).toContain('Nothing to allocate');
    expect(r.message).toContain('still owes £254.17');
  });

  it('is logged step by step with who pressed', async () => {
    await runHireAllocation(JOB.id, 'u1');
    expect(logRows.map((l) => l.step)).toEqual(expect.arrayContaining(['preflight', 'allocate_hh', 'xero']));
    expect(logRows.find((l) => l.step === 'preflight')).toMatchObject({ ok: true, user_id: 'u1' });
    expect(logRows.find((l) => l.step === 'allocate_hh')!.hh_refs).toEqual({ depositId: 8661, invoiceId: 12252, amount: 254.17 });
  });
});

describe('completeHireJob', () => {
  async function settle() {
    // Allocate, then refund the surplus by hand so nothing is unallocated.
    await runHireAllocation(JOB.id, 'u1');
    hh.deposits[0].allocated = hh.deposits[0].credit;
    hh.apps.push({ id: 950, invoiceId: 0, depositId: 8661, amount: 886.8, desc: '16015 - Refund (deposit)' });
    opPayments.push({ hirehop_deposit_id: 8661, payment_type: 'refund', amount: 886.8, payment_method: 'stripe_gbp', source: 'op', notes: null });
    mockPost.mockClear();
  }

  it('refuses while the client still owes money', async () => {
    hh.deposits[0].credit = 100; opPayments[0].amount = 100; xero.overpayments['op-8661'].remaining = 100;
    await runHireAllocation(JOB.id, 'u1');
    const r = await completeHireJob(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('still shows £154.17 owing');
    expect(posts('/frames/status_save.php')).toEqual([]);
  });

  it('refuses while money is unallocated, naming the three choices', async () => {
    await runHireAllocation(JOB.id, 'u1');
    const r = await completeHireJob(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('£886.80 of the client\'s money is unallocated');
    expect(r.message).toContain('held on account');
  });

  it('completes once everything is settled in HireHop and Xero, and mirrors it into OP at once', async () => {
    await settle();
    const r = await completeHireJob(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(hh.jobStatus).toBe(11);
    expect(r.plan.hhStatus).toBe(11);
    expect(mockStatus).toHaveBeenCalledWith({ STATUS: 11 }, undefined, 16015);
  });

  it('a job OP knows is Completed is answered from the log, not HireHop, unless asked fresh', async () => {
    await settle();
    await completeHireJob(JOB.id, 'u1');
    mockRead.mockClear();
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM jobs WHERE')) return { rows: [{ ...JOB, pipeline_status: 'completed' }] };
      if (sql.includes('FROM job_requirements')) return { rows: [{ invoice_req_id: null, invoice_req_status: null, open_problems: 0 }] };
      if (sql.includes('FROM job_closeout_log')) return { rows: logRows };
      if (sql.includes('INSERT INTO job_closeout_log')) { logRows.unshift({ id: 'x', step: params[1], ok: params[2], detail: params[3], hh_refs: null, user_id: params[5], user_name: null, created_at: 'now' }); return { rows: [] }; }
      if (sql.includes('FROM job_payments')) return { rows: opPayments };
      if (sql.includes('FROM v_excess_held')) return { rows: [{ held: excessHeld }] };
      if (sql.includes('FROM job_excess')) return { rows: [{ claimed: excessClaimed }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const light = await planHireCloseOut(JOB.id);
    expect(light.fromLog).toBe(true);
    expect(light.sentences[0]).toContain('Completed in HireHop');
    expect(mockRead).not.toHaveBeenCalled();
    const fresh = await planHireCloseOut(JOB.id, { fresh: true });
    expect(fresh.fromLog).toBeUndefined();
    expect(mockRead).toHaveBeenCalled();
  });

  it('refuses when Xero still shows money due, even though HireHop is settled', async () => {
    await settle();
    xero.invoiceDue['x-12252'] = 254.17;
    const r = await completeHireJob(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('still shows £254.17 due in Xero');
    expect(hh.jobStatus).toBe(7);
  });

  it('excess still held: refuses by default, completes with the manager override', async () => {
    await settle();
    excessHeld = 1200;
    const first = await completeHireJob(JOB.id, 'u1');
    expect(first.done).toBe(false);
    expect(first.message).toContain('£1200.00 excess is still held');
    const second = await completeHireJob(JOB.id, 'u1', { allowExcessHeld: true });
    expect(second.done).toBe(true);
    expect(hh.jobStatus).toBe(11);
    expect(logRows[0].detail).toContain('manager override');
  });
});

describe('raiseHireInvoice', () => {
  /** A returned hire, paid in full, nothing invoiced yet (the job jon opened on 9 Oct). */
  function uninvoicedJob() {
    hh.invoices = []; hh.apps = [];
    hh.accruedNet = 510; hh.uninvoicedNet = 510;          // £612 inc VAT
    hh.deposits = [{ id: 9500, credit: 612, bank: 267, allocated: 0, desc: '16100 - deposit', date: '2026-09-20' }];
    opPayments = [{ hirehop_deposit_id: 9500, payment_type: 'deposit', amount: 612, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null }];
    installXero();
  }

  it('the plan says what is left to invoice and that Allocate must wait for the invoice', async () => {
    uninvoicedJob();
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.invoice).toMatchObject({ accruedNet: 510, invoicedNet: 0, netToInvoice: 510, draft: null, euTrigger: false, ready: true });
    expect(plan.blockers.join(' ')).toContain('Raise the invoice first');
  });

  it('drafts from the uninvoiced lines, penny-checks, approves dated today, pushes to Xero', async () => {
    uninvoicedJob();
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([expect.objectContaining({ all: 1, job: 16015, ref: 'Job 16015' })]);
    expect(posts('/php_functions/billing_save_status.php')).toEqual([expect.objectContaining({ id: 13000, status: 2 })]);
    expect(mockSync.mock.calls[0][1]).toMatchObject({ hh_task: 'post_invoice_credit', hh_id: 13000 });
    expect(hh.invoices[0]).toMatchObject({ status: 2, number: 'OT-INV-13000', accId: 'x-13000', gross: 612 });
    expect(r.message).toContain('OT-INV-13000');
    // The payments half of the plan now has something to do.
    expect(r.plan.invoice.netToInvoice).toBe(0);
    expect(r.plan.allocations).toEqual([expect.objectContaining({ depositId: 9500, amount: 612, invoiceId: 13000 })]);
    expect(logRows.map((l) => l.step)).toEqual(expect.arrayContaining(['invoice_draft', 'invoice_penny', 'invoice_approve', 'xero']));
  });

  it('the first invoice is laid out like the quote: an empty draft, the supply list pasted in its own order', async () => {
    uninvoicedJob();
    layout = '';                                            // the default: no setting row
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([expect.objectContaining({ all: 0, job: 16015 })]);
    const [paste] = posts('/php_functions/billing_paste.php');
    expect(paste).toMatchObject({
      bill: 13000, selected: '', origin_type: 1, origin_id: 16015,
      'data[0][ID]': 8818, 'data[0][kind]': 0, 'data[1][ID]': '164980',
      // Multiplied out as HireHop's grid does — the feed's £250/day × 2 days (16849 went on at half price).
      'data[1][UNIT_PRICE]': 500, 'data[1][PRICE]': 500, 'data[1][inv_PRICE]': 500, 'data[1][inv_UNIT_PRICE]': 500,
      'data[1][ACC_NOMINAL]': 0, 'data[1][DURATION]': 0,
      'data[2][kind]': 3, 'data[3][ID]': 169041,
    });
    expect(Object.keys(paste).some((k) => k.includes('TYPE_CUSTOM_FIELDS'))).toBe(false);   // objects are not sent
    expect(hh.invoices[0]).toMatchObject({ status: 2, number: 'OT-INV-13000', gross: 612 });
    expect(logRows.find((l) => l.step === 'invoice_draft')?.detail).toContain('laid out like the quote');
  });

  it('stops at the draft when the paste leaves a priced line off — never approved', async () => {
    uninvoicedJob();
    layout = '';
    pasteDrops = 169041;
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('doesn\'t match the supply list');
    expect(r.message).toContain('Cost / fee / recharge');
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('a top-up invoice stays "all owing items" — pasting the whole list again would invoice lines twice', async () => {
    layout = '';
    hh.accruedNet = 5169.99; hh.uninvoicedNet = 100;        // £100 added after OT-INV-12252
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(posts('/php_functions/billing_save.php')).toEqual([expect.objectContaining({ all: 1 })]);
    expect(posts('/php_functions/billing_paste.php')).toEqual([]);
    expect(r.message).not.toContain('supply list');
  });

  it('adopts a draft already on the job instead of raising a second one', async () => {
    uninvoicedJob();
    hh.invoices.push({ id: 12990, status: 0, number: '', gross: 612, paid: 0, accId: '', date: '2026-10-08' }); hh.uninvoicedNet = 0;
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([]);
    expect(posts('/php_functions/billing_save_status.php')).toEqual([expect.objectContaining({ id: 12990 })]);
  });

  it('stops at the draft when the pennies do not agree — nothing approved, nothing to Xero', async () => {
    uninvoicedJob();
    hh.uninvoicedNet = 500;                                   // HireHop bills £500 of a £510 job
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('£10.00 apart');
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
    expect(mockSync).not.toHaveBeenCalled();
    expect(hh.invoices[0].status).toBe(0);
  });

  it('job 16724: a pasted draft that Billing disagrees with names both HireHop tabs', async () => {
    // Supplying prices the job at £510 (what is pasted); Billing works it out £39.37 lower.
    uninvoicedJob(); layout = ''; hh.accruedNet = 470.63;
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('Draft 13000 has the Supplying tab\'s lines, £510.00 ex VAT');
    expect(r.message).toContain('Billing tab says the job comes to £470.63 ex VAT (£39.37 apart)');
    expect(r.message).toContain('delete draft 13000 in HireHop');
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
    expect(logRows[0]).toMatchObject({ step: 'invoice_penny', ok: false });
  });

  it('a draft already on the job that Billing disagrees with says so, and how to clear it', async () => {
    uninvoicedJob(); hh.uninvoicedNet = 0; hh.accruedNet = 158.13;
    hh.invoices.push({ id: 12995, status: 0, number: '', gross: 237, paid: 0, accId: '', date: '2026-10-20' });
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('Draft 12995, already on the job, is £197.50 ex VAT');
    expect(r.message).toContain('(£39.37 apart)');
    expect(r.message).toContain('or delete draft 12995');
    expect(posts('/php_functions/billing_save.php')).toEqual([]);
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
  });

  it('an EU hire: splits the VAT on the draft, then approves it in the same press like any other invoice', async () => {
    uninvoicedJob(); hh.euTrigger = true;
    const plan = await planHireCloseOut(JOB.id);
    expect(plan.invoice).toMatchObject({ euTrigger: true, ready: true });
    expect(plan.warnings.join(' ')).toContain('EU hire');

    mockSplit.mockResolvedValueOnce('split');
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(mockSplit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hhJobNumber: 16015, draftId: 13000, firstInvoice: true }));
    // Split BEFORE approve, then approved and sent to Xero.
    const approveCall = mockPost.mock.calls.findIndex((c) => c[0] === '/php_functions/billing_save_status.php');
    expect(mockSplit.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[approveCall]);
    expect(posts('/php_functions/billing_save_status.php')).toEqual([expect.objectContaining({ id: 13000, status: 2 })]);
  });

  it('an EU hire whose split stops is never approved', async () => {
    uninvoicedJob(); hh.euTrigger = true;
    mockSplit.mockRejectedValueOnce(new Stop('Draft 13000 is not split correctly'));
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(false);
    expect(r.message).toContain('not split correctly');
    expect(posts('/php_functions/billing_save_status.php')).toEqual([]);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('a non-EU hire never calls the split', async () => {
    uninvoicedJob();
    await raiseHireInvoice(JOB.id, 'u1');
    expect(mockSplit).not.toHaveBeenCalled();
  });

  it('a job still out: refuses by default, raises with the manager override', async () => {
    uninvoicedJob(); hh.jobStatus = 5;
    const first = await raiseHireInvoice(JOB.id, 'u1');
    expect(first.done).toBe(false);
    expect(first.message).toContain("hasn't returned yet");
    const second = await raiseHireInvoice(JOB.id, 'u1', { allowNotReturned: true });
    expect(second.done).toBe(true);
  });

  it('a later charge: invoices only the new line, and the penny check counts what was already invoiced', async () => {
    // 16015 corrected is fully invoiced (5069.99); a £100 damage line is added.
    hh.accruedNet = 5169.99; hh.uninvoicedNet = 100;
    const r = await raiseHireInvoice(JOB.id, 'u1');
    expect(r.done).toBe(true);
    const second = hh.invoices.find((i) => i.id === 13000)!;
    expect(second.gross).toBe(120);
    expect(r.message).toContain('£120.00');
  });

  it('says so when there is nothing to invoice', async () => {
    const r = await raiseHireInvoice(JOB.id, 'u1');       // 16015 corrected: fully invoiced
    expect(r.done).toBe(false);
    expect(r.message).toContain('Nothing to invoice');
  });
});

describe('runHireCloseOut (the one button)', () => {
  function uninvoicedJob() {
    hh.invoices = []; hh.apps = [];
    hh.accruedNet = 510; hh.uninvoicedNet = 510;
    hh.deposits = [
      { id: 9329, credit: 153, bank: 267, allocated: 0, desc: '16756 - deposit', date: '2026-09-24' },
      { id: 9360, credit: 459, bank: 267, allocated: 0, desc: '16756 - balance', date: '2026-09-29' },
    ];
    opPayments = [
      { hirehop_deposit_id: 9329, payment_type: 'deposit', amount: 153, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
      { hirehop_deposit_id: 9360, payment_type: 'balance', amount: 459, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
    ];
    installXero();
  }

  it('job 16756: one press raises the invoice, allocates both payments in HireHop and Xero, and is ready to complete', async () => {
    uninvoicedJob();
    const r = await runHireCloseOut(JOB.id, 'u1');
    expect(r.done).toBe(true);
    expect(hh.invoices[0]).toMatchObject({ status: 2, gross: 612, paid: 612 });
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([
      expect.objectContaining({ deposit: 9329, paid: 153 }),
      expect.objectContaining({ deposit: 9360, paid: 459 }),
    ]);
    expect(xero.invoiceDue['x-13000']).toBe(0);
    expect(r.plan.readyToComplete).toBe(true);
    expect(r.message).toContain('OT-INV-13000');
    expect(r.message).toContain('Ready to complete');
  });

  it('with the invoice already raised, the same button just allocates', async () => {
    const r = await runHireCloseOut(JOB.id, 'u1');     // 16015 corrected: invoiced, £254.17 to allocate
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([]);
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([expect.objectContaining({ deposit: 8661, paid: 254.17 })]);
  });

  it('stops at the draft on a penny mismatch and carries on from there once fixed', async () => {
    uninvoicedJob(); hh.uninvoicedNet = 500;
    const first = await runHireCloseOut(JOB.id, 'u1');
    expect(first.done).toBe(false);
    expect(first.message).toContain('£10.00 apart');
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([]);
    // Someone fixes the lines in HireHop: the draft now reads £510.
    hh.invoices[0].gross = 612; hh.accruedNet = 510;
    const second = await runHireCloseOut(JOB.id, 'u1');
    expect(second.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toHaveLength(1);       // no second draft
    expect(second.plan.readyToComplete).toBe(true);
  });
});

describe('allocateOnArrival (the arrival hook, §4.5)', () => {
  /** A fresh £254.17 portal payment, newer than everything else on the job. */
  const newPayment = () => {
    hh.deposits.push({ id: 9500, credit: 254.17, bank: 267, allocated: 0, desc: '16015 - balance', date: '2026-10-10' });
    opPayments.push({ hirehop_deposit_id: 9500, payment_type: 'balance', amount: 254.17, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null });
    xero.overpayments['op-9500'] = { remaining: 254.17, allocations: [] };
  };

  it('does nothing at all while the setting is off', async () => {
    arrivalEnabled = 'false';
    expect(await allocateOnArrival(JOB.id, 8661)).toBe('off');
    expect(mockRead).not.toHaveBeenCalled();
    expect(logRows).toEqual([]);
  });

  it('the payment that arrived pays the one invoice owing, in HireHop and Xero, logged with no user — and never completes the job', async () => {
    hh.deposits[0].allocated = 1140.97; hh.apps.push({ id: 901, invoiceId: 99, depositId: 8661, amount: 1140.97 });  // 8661 spent elsewhere
    newPayment();
    expect(await allocateOnArrival(JOB.id, 9500)).toBe('allocated');
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([
      expect.objectContaining({ deposit: 9500, OWNER: 12252, paid: 254.17, id: 0 }),
    ]);
    expect(xero.invoiceDue['x-12252']).toBe(0);
    expect(posts('/frames/status_save.php')).toEqual([]);
    expect(logRows.find((l) => l.step === 'arrival')).toMatchObject({ ok: true, user_id: null });
    expect(logRows.every((l) => l.user_id === null)).toBe(true);
  });

  it('never uses money already sitting on the job: an older unallocated payment means a person decides', async () => {
    newPayment();   // 8661 still holds £1,140.97 and is older, so the §5 rule would take it first
    expect(await allocateOnArrival(JOB.id, 9500)).toBe('stopped');
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([]);
    expect(mockXeroAllocate).not.toHaveBeenCalled();
    expect(logRows[0]).toMatchObject({ step: 'arrival', ok: false });
    expect(logRows[0].detail).toContain('8661');
  });

  it('is silent when there is no invoice owing (the usual case: payment before the hire)', async () => {
    hh.invoices[0].paid = hh.invoices[0].gross;
    newPayment();
    expect(await allocateOnArrival(JOB.id, 9500)).toBe('skipped');
    expect(mockPost).not.toHaveBeenCalled();
    expect(logRows).toEqual([]);
  });

  it('is silent for an excess payment', async () => {
    expect(await allocateOnArrival(JOB.id, 9093)).toBe('skipped');
    expect(mockPost).not.toHaveBeenCalled();
    expect(logRows).toEqual([]);
  });

  it('stops at pre-flight, writing nothing, when HireHop and OP disagree', async () => {
    newPayment();
    opPayments = opPayments.filter((p) => p.hirehop_deposit_id !== 9500);
    expect(await allocateOnArrival(JOB.id, 8661)).toBe('stopped');
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([]);
    expect(logRows[0]).toMatchObject({ step: 'preflight', ok: false });
  });

  it('fireArrivalHook never throws into the payment; a failure is logged for a person', async () => {
    mockRead.mockRejectedValue(new Error('HireHop unreachable'));
    expect(() => fireArrivalHook(JOB.id, 8661)).not.toThrow();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(logRows[0]).toMatchObject({ step: 'arrival', ok: false });
    expect(logRows[0].detail).toContain('HireHop unreachable');
  });
});

// ── A cancelled job: the fee, not the hire (CANCELLATION-SPEC.md, the money end) ──

describe('a cancelled job (job 16739)', () => {
  /** 16739 as it stood on 14 Oct 2026: hire paid in full by Stripe, excess already refunded, fee £412.50 + VAT. */
  let reminders: Array<{ id: string; amount: number }>;
  let opWrites: Array<{ sql: string; params: any[] }>;
  const CANCELLED = {
    ...JOB, hh_job_number: 16739, job_name: 'AEG Presents - PREMIUM', pipeline_status: 'cancelled',
    cancellation_fee: '412.50', cancelled_at: '2026-10-08T12:00:00Z', job_date: '2026-10-12T08:00:00Z', job_end: '2026-10-23T08:00:00Z',
  };
  let job: any;

  beforeEach(() => {
    job = { ...CANCELLED };
    hh = {
      jobStatus: 9, nextApp: 900, ignoreAllocations: false,
      accruedNet: 1650, uninvoicedNet: 1650, euTrigger: false, nextInvoice: 13100,
      invoices: [],
      deposits: [
        { id: 9354, credit: 495, bank: 267, allocated: 0, desc: '16739 - deposit', date: '2026-09-28' },
        { id: 9412, credit: 1485, bank: 267, allocated: 0, desc: '16739 - balance', date: '2026-10-08' },
        { id: 9413, credit: 1200, bank: 267, allocated: 1200, desc: '16739 - excess (Full excess - 1 van(s))', date: '2026-10-08' },
      ],
      apps: [{ id: 904, invoiceId: 0, depositId: 9413, amount: 1200 }],   // the excess, refunded
    };
    opPayments = [
      { hirehop_deposit_id: 9354, payment_type: 'deposit', amount: 495, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
      { hirehop_deposit_id: 9412, payment_type: 'balance', amount: 1485, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
      { hirehop_deposit_id: 9413, payment_type: 'excess', amount: 1200, payment_method: 'stripe_gbp', source: 'payment_portal', notes: null },
    ];
    reminders = [{ id: 'iou-1', amount: 1485 }];
    opWrites = [];
    installXero();
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM jobs WHERE')) return { rows: [{ ...job }] };
      if (sql.includes("payment_status = 'pending'") && sql.includes('SELECT')) return { rows: reminders };
      if (sql.includes('INSERT INTO interactions')) { opWrites.push({ sql, params }); return { rows: [] }; }
      if (sql.includes('UPDATE job_requirements')) { opWrites.push({ sql, params }); return { rows: [] }; }
      if (sql.includes('INSERT INTO job_payments')) { opWrites.push({ sql, params }); reminders.push({ id: 'iou-new', amount: params[1] }); return { rows: [] }; }
      if (sql.includes('UPDATE job_payments')) { opWrites.push({ sql, params }); reminders = reminders.map((r) => (r.id === params[0] ? { ...r, amount: params[1] } : r)); return { rows: [] }; }
      return base(sql, params);
    });
  });

  it('plans the FEE, not the hire: £412.50 + VAT to invoice, nothing allocated yet, the excess left alone', async () => {
    const plan = await planHireCloseOut('16739');
    expect(plan.cancellation).toEqual(expect.objectContaining({ feeNet: 412.5, feeGross: 495, invoiced: false, settled: false }));
    expect(plan.invoice.netToInvoice).toBe(412.5);                   // not the £1,650 hire
    expect(plan.invoice.blockers).toEqual([]);
    expect(plan.blockers).toEqual(['Raise the invoice first — the job has no approved invoice in HireHop.']);
    expect(plan.warnings.some((w) => w.includes("hasn't returned"))).toBe(false);
    expect(plan.sentences[0]).toBe('Raise the cancellation fee invoice: £412.50 + VAT = £495.00.');
    expect(plan.payments.map((p) => p.depositId)).toEqual([9354, 9412]);   // 9413 is excess
    expect(plan.readyToComplete).toBe(false);
  });

  it('one press: the fee invoice (one Misc line, 20%), approved, in Xero; £495 of 9354 allocated; the £1,485 left to refund', async () => {
    const r = await runHireCloseOut('16739', 'u-jon');
    expect(r.done).toBe(true);
    expect(posts('/php_functions/billing_save.php')).toEqual([expect.objectContaining({ all: 0, job: 16739 })]);
    const lines = posts('/php_functions/billing_save_item.php');
    expect(lines).toEqual([expect.objectContaining({ id: 0, kind: 3, total: 412.5, vat_rate: 20, vat_id: 20, nominal_id: 190 })]);
    expect(lines[0].note).toBe('Cancellation fee (T&Cs clause 7) - cancelled 8 Oct 2026');
    expect(lines[0].note.length).toBeLessThanOrEqual(80);                 // HireHop keeps 80 characters
    expect(posts('/php_functions/billing_payments_save.php')).toEqual([expect.objectContaining({ deposit: 9354, paid: 495, OWNER: 13100 })]);
    expect(mockXeroAllocate).toHaveBeenCalledWith(expect.objectContaining({ overpaymentId: 'op-9354', amount: 495 }));
    expect(xero.invoiceDue['x-13100']).toBe(0);
    expect(posts('/frames/status_save.php')).toEqual([]);              // never completed
    expect(r.plan.invoices).toEqual([expect.objectContaining({ number: 'OT-INV-13100', gross: 495, owing: 0, chargeOnly: true })]);
    expect(r.plan.surplus).toEqual([{ depositId: 9412, amount: 1485 }]);
    expect(r.plan.sentences).toContain('Refund £1485.00 of payment 9412 to the client.');
    expect(r.message).toContain('Fee invoice OT-INV-13100 raised for £495.00');
    expect(r.message).toContain('The pending refund of £1485.00 on the Money tab is ready');
    expect(opWrites.filter((w) => w.sql.includes('job_payments'))).toEqual([]);   // the reminder was already right
    expect(opWrites.some((w) => w.sql.includes('INSERT INTO interactions') && String(w.params[1]).includes('OT-INV-13100'))).toBe(true);
    expect(r.plan.cancellation!.settled).toBe(false);                 // £1,485 still to go back
    expect(opWrites.some((w) => w.sql.includes('UPDATE job_requirements'))).toBe(false);   // not reconciled yet
  });

  it('settled once the rest is refunded', async () => {
    await runHireCloseOut('16739', 'u-jon');
    hh.deposits.find((d) => d.id === 9412)!.allocated = 1485;           // the refund (OWNER 0), with OP's record of it
    hh.apps.push({ id: 905, invoiceId: 0, depositId: 9412, amount: 1485, desc: 'Refund' });
    opPayments.push({ hirehop_deposit_id: 9412, payment_type: 'refund', amount: 1485, payment_method: 'stripe_gbp', source: 'op', notes: null });
    const plan = await planHireCloseOut('16739');
    expect(plan.blockers).toEqual([]);
    expect(plan.surplus).toEqual([]);
    expect(plan.cancellation!.settled).toBe(true);
    // …and ticks the job's Payment Reconciliation card ("Process refund of £x").
    expect(opWrites.some((w) => w.sql.includes("requirement_type = 'payment_reconcile'") && w.params[0] === JOB.id)).toBe(true);
  });

  it('a reminder that guessed wrong follows the real figure; none at all gets one made', async () => {
    reminders = [{ id: 'iou-1', amount: 1000 }];
    let r = await runHireCloseOut('16739', 'u-jon');
    expect(r.message).toContain('now £1485.00 (was £1000.00)');
    expect(reminders).toEqual([{ id: 'iou-1', amount: 1485 }]);

    reminders = [];
    r = await runHireAllocation('16739', 'u-jon');
    expect(r.message).toContain('A pending refund of £1485.00');
    expect(reminders).toEqual([{ id: 'iou-new', amount: 1485 }]);
  });

  it('a fee bigger than what was paid: allocated in full, the rest owed (the portal takes it)', async () => {
    job.cancellation_fee = '2000';
    const r = await runHireCloseOut('16739', 'u-jon');
    expect(r.done).toBe(true);
    expect(r.plan.invoices[0].gross).toBe(2400);
    expect(r.plan.invoices[0].owing).toBe(420);                        // £2,400 − £1,980
    expect(r.plan.surplus).toEqual([]);
    expect(r.message).toContain('The client still owes £420.00');
    expect(reminders).toEqual([{ id: 'iou-1', amount: 1485 }]);        // left alone — and said so
    expect(r.message).toContain('Nothing is left to refund, but OP still has a pending refund of £1485.00');
  });

  it('refuses to raise the fee while HireHop does not show the job Cancelled — nothing written', async () => {
    hh.jobStatus = 2;
    const r = await runHireCloseOut('16739', 'u-jon');
    expect(r.done).toBe(false);
    expect(r.message).toContain("doesn't show job 16739 as Cancelled (status 2)");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses a job whose hire was invoiced before it was cancelled (that needs a credit note) — nothing written', async () => {
    hh.invoices.push({ id: 12999, status: 2, number: 'OT-INV-12999', gross: 1980, paid: 0, accId: 'x-12999', date: '2026-10-01', items: [{ ID: 1, MAIN_ID: 164980, KIND: 2, PRICE: 1650 }] });
    const plan = await planHireCloseOut('16739');
    expect(plan.blockers.some((b) => b.includes('needs a credit note'))).toBe(true);
    const r = await runHireCloseOut('16739', 'u-jon');
    expect(r.done).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('is never completed', async () => {
    await runHireCloseOut('16739', 'u-jon');
    const r = await completeHireJob('16739', 'u-jon');
    expect(r.done).toBe(false);
    expect(r.message).toContain('never completed');
    expect(posts('/frames/status_save.php')).toEqual([]);
  });

  it('no fee at all: nothing to invoice, everything is a refund', async () => {
    job.cancellation_fee = '0';
    const plan = await planHireCloseOut('16739');
    expect(plan.blockers).toEqual([]);
    expect(plan.invoice.netToInvoice).toBe(0);
    expect(plan.surplus).toEqual([{ depositId: 9354, amount: 495 }, { depositId: 9412, amount: 1485 }]);
  });

  it('a lost job is still refused', async () => {
    job.pipeline_status = 'lost';
    const plan = await planHireCloseOut('16739');
    expect(plan.blockers).toEqual(['This job is lost — there is nothing to invoice.']);
  });
});
