/**
 * Excess Reimburse asks HireHop BEFORE the card is refunded.
 *
 * Job 16491 (Oct 2026): £841.32 of a £1,200 excess (HireHop payment 9053) was
 * applied to the damage invoice OT-INV-12350 by hand in HireHop. OP didn't know,
 * so the Reimburse form offered the full £1,200 — and the route refunded Stripe
 * first and only then asked HireHop, which can't refund money that sits on an
 * invoice (error 370). The hire Refund has asked first since job 15628.
 *
 * What these pin down: a refund bigger than HireHop has free is refused with
 * nothing moved (no Stripe, no HireHop write, no OP update); the right amount
 * goes through and "Retained by Ooosh" books the rest as claimed; a failed or
 * empty HireHop read is a refusal, never a guess; a carried-over excess is
 * looked for on the job that took the money.
 *
 * No database, no HireHop, no Stripe: fakes that record what they're asked.
 * The route is called through the router's own table.
 */
import type { Router } from 'express';

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn(), getPool: jest.fn() }));
jest.mock('../../services/hirehop-broker', () => {
  const broker = { post: jest.fn(), get: jest.fn() };
  return { __esModule: true, default: broker, hhBroker: broker };
});
jest.mock('../../config/stripe', () => ({
  getStripeClient: jest.fn(),
  isStripeConfigured: () => true,
  isStripeError: () => false,
}));
const mockRefundCreate = jest.fn();
jest.mock('../../services/stripe-terminal', () => ({
  stripeClientForPaymentIntent: jest.fn(async () => ({ refunds: { create: mockRefundCreate } })),
}));
jest.mock('../../services/hh-xero-sync', () => ({
  syncSavedRowToXero: jest.fn(async () => ({ ok: true, error: null })),
  sendXeroSyncFailedAlert: jest.fn(),
}));
jest.mock('../../services/money-emails', () => ({ sendExcessEmail: jest.fn(async () => undefined) }));
jest.mock('../../services/excess-requirement-sync', () => ({ syncExcessRequirementStatus: jest.fn(async () => undefined) }));
jest.mock('../../services/email-service', () => ({ emailService: { send: jest.fn() } }));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Required, not imported: an import is hoisted above the env lines.
const db = require('../../config/database');
const { hhBroker } = require('../../services/hirehop-broker');
const { excessRefundShortfall } = require('../../services/excess-refund');
const excessRouter: Router = require('../excess').default;

const EXCESS_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const USER = '2d8f4c74-8c3b-4e77-9d2a-9e3f4a5b6c7d';
const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();

/** Job 16491's excess record as OP had it: £1,200 taken, nothing claimed. */
let record: Record<string, unknown>;
/** Jobs the "where else could this deposit be" query names. */
let homeJobs: number[];
/** Billing rows per HireHop job number. */
let billing: Record<number, any[]>;

/** HireHop's billing for a job holding an excess deposit, part of it applied to an invoice by hand. */
function excessBilling(depositId: number, credit: number, applied: number, invoiceId = 12350, invoiceNumber = 'OT-INV-12350') {
  const rows: any[] = [
    { kind: 6, credit, owing: -(Math.round((credit - applied) * 100) / 100), paid: applied,
      data: { ID: depositId, DESCRIPTION: '16491 - excess (Full excess - 1 van(s))', ACC_ACCOUNT_ID: 267 } },
  ];
  if (applied > 0) {
    // Dual-published, like HireHop: deposit-side (credit < 0) and invoice-side twins.
    rows.push({ kind: 3, credit: -applied, data: { ID: 5501, OWNER: invoiceId, OWNER_DEPOSIT: depositId, INVOICE_NUMBER: invoiceNumber, parent_is: 'deposit', DATE: '2026-10-27' } });
    rows.push({ kind: 3, credit: applied, data: { ID: 5501, OWNER: invoiceId, OWNER_DEPOSIT: depositId, parent_is: 'invoice' } });
  }
  return rows;
}

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b?: unknown) => { res.body = b; return res; };
  return res;
}

/** Run the route's own handlers in order (authorize → validate → handler). */
async function reimburse(body: Record<string, unknown>) {
  const layer = (excessRouter.stack as any[]).find((l) => l.route?.path === '/:id/reimburse' && l.route.methods.post);
  if (!layer) throw new Error('no route POST /:id/reimburse');
  const res = fakeRes();
  const req = { method: 'POST', originalUrl: `/api/excess/${EXCESS_ID}/reimburse`, params: { id: EXCESS_ID }, query: {}, body,
    user: { id: USER, email: 'jon@example.com', role: 'admin' } };
  for (const s of layer.route.stack) {
    let nexted = false;
    await s.handle(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

const sqlSent = () => (db.query as jest.Mock).mock.calls.map((c) => flat(c[0]));
const opRecordWrites = () => (db.query as jest.Mock).mock.calls.filter((c) => /^UPDATE job_excess SET excess_status/.test(flat(c[0])));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});

  record = {
    id: EXCESS_ID, job_id: 'f6323a27-4c5f-4935-a514-393f7146c4fe', hirehop_job_id: 16491, hh_deposit_id: 9053,
    excess_amount_taken: '1200.00', claim_amount: '0.00', reimbursement_amount: '0.00',
    stripe_payment_intent_id: 'pi_16491excess', payment_method: 'stripe_gbp', excess_status: 'taken',
    client_name: 'Mark Jones', notes: null, bank_details_encrypted: null,
  };
  homeJobs = [16491];
  billing = { 16491: excessBilling(9053, 1200, 841.32) };

  (db.query as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = flat(sql);
    if (s.startsWith('SELECT * FROM job_excess WHERE id = $1')) return { rows: [{ ...record }] };
    if (s.includes('AS hh FROM job_excess')) return { rows: homeJobs.map((hh) => ({ hh })) };
    if (s.startsWith('UPDATE job_excess SET excess_status')) {
      return { rows: [{ ...record, excess_status: params[0], reimbursement_amount: params[1], claim_amount: params[4] }] };
    }
    return { rows: [] };
  });
  // HireHop's billing read, as the broker answers it.
  (hhBroker.get as jest.Mock).mockImplementation(async (path: string, params: { main_id: number }) => {
    if (path === '/php_functions/billing_list.php') return { success: true, data: { rows: billing[params.main_id] || [] } };
    throw new Error(`unexpected GET ${path}`);
  });
  mockRefundCreate.mockResolvedValue({ id: 're_test_1' });
  (hhBroker.post as jest.Mock).mockResolvedValue({ success: true, data: { hh_id: 7001, hh_task: 'post_payment' } });
});
afterEach(() => jest.restoreAllMocks());

describe('POST /excess/:id/reimburse — HireHop is asked first', () => {
  it('16491: refuses £1,200 when HireHop has only £358.68 free — nothing refunded, nothing written', async () => {
    const res = await reimburse({ amount: 1200, method: 'stripe_gbp' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('hh_not_enough_free');
    expect(res.body.detail).toContain('£358.68');
    expect(res.body.detail).toContain('OT-INV-12350');
    expect(res.body.detail).toContain('Retained by Ooosh');
    expect(res.body.detail).toContain('Nothing has been refunded');
    expect(mockRefundCreate).not.toHaveBeenCalled();
    expect(hhBroker.post).not.toHaveBeenCalled();
    expect(opRecordWrites()).toHaveLength(0);
    expect(sqlSent().some((s) => s.includes('refund_legs'))).toBe(false);
  });

  it('16491: £358.68 + "Retained by Ooosh" refunds the card, refunds 9053 in HireHop and books £841.32 as claimed', async () => {
    const res = await reimburse({ amount: 358.68, method: 'stripe_gbp', retain_residual: true });
    expect(res.statusCode).toBe(200);
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockRefundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_16491excess', amount: 35868 });
    expect(hhBroker.post).toHaveBeenCalledWith('/php_functions/billing_payments_save.php',
      expect.objectContaining({ OWNER: 0, deposit: 9053, paid: 358.68 }), expect.anything());
    const write = opRecordWrites();
    expect(write).toHaveLength(1);
    expect(write[0][1][0]).toBe('reimbursed');                 // status
    expect(write[0][1][4]).toBeCloseTo(841.32, 2);             // claim_amount — the hand-made allocation, now known to OP
    // HireHop was read before Stripe moved anything.
    const readOrder = (hhBroker.get as jest.Mock).mock.invocationCallOrder[0];
    expect(readOrder).toBeLessThan(mockRefundCreate.mock.invocationCallOrder[0]);
  });

  it('a HireHop read that fails is a refusal, never a guess', async () => {
    (hhBroker.get as jest.Mock).mockResolvedValue({ success: false, error: 'HireHop is having problems' });
    const res = await reimburse({ amount: 358.68, method: 'stripe_gbp', retain_residual: true });
    expect(res.statusCode).toBe(502);
    expect(res.body.detail).toContain('Nothing has been refunded');
    expect(mockRefundCreate).not.toHaveBeenCalled();
    expect(hhBroker.post).not.toHaveBeenCalled();
    expect(opRecordWrites()).toHaveLength(0);
  });

  it('a deposit HireHop no longer has is a refusal pointing at Link HH Deposit', async () => {
    billing = { 16491: [] };
    const res = await reimburse({ amount: 100, method: 'stripe_gbp' });
    expect(res.statusCode).toBe(422);
    expect(res.body.detail).toContain('Link HH Deposit');
    expect(mockRefundCreate).not.toHaveBeenCalled();
    expect(hhBroker.post).not.toHaveBeenCalled();
  });

  it('a carried-over excess is found on the job that took the money (#16371), not only its own (#16605)', async () => {
    record = { ...record, hirehop_job_id: 16605, hh_deposit_id: 7767, payment_method: 'rolled_over' };
    homeJobs = [16371, 16605];
    billing = { 16605: [], 16371: excessBilling(7767, 1200, 0) };
    const res = await reimburse({ amount: 1200, method: 'stripe_gbp' });
    expect(res.statusCode).toBe(200);
    expect((hhBroker.get as jest.Mock).mock.calls.map((c) => c[1].main_id)).toEqual([16605, 16371]);
    expect(mockRefundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_16491excess', amount: 120000 });
  });

  it('a non-card reimbursement is held to the same check', async () => {
    const res = await reimburse({ amount: 1200, method: 'wise_bacs' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('hh_not_enough_free');
    expect(hhBroker.post).not.toHaveBeenCalled();
    expect(opRecordWrites()).toHaveLength(0);
  });

  it('a whole excess still free goes straight through (the everyday case)', async () => {
    billing = { 16491: excessBilling(9053, 1200, 0) };
    const res = await reimburse({ amount: 1200, method: 'stripe_gbp' });
    expect(res.statusCode).toBe(200);
    expect(mockRefundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_16491excess', amount: 120000 });
    expect(opRecordWrites()).toHaveLength(1);
  });
});

describe('excessRefundShortfall (the sentence staff see)', () => {
  const availability = (available: number, apps: Array<{ invoiceId: number; invoiceNumber: string | null; amount: number }>) => ({
    depositId: 9053, credit: 1200, available, readingsAgree: true,
    applications: apps.map((a, i) => ({ applicationId: 100 + i, date: '', bankId: 267, description: '', memo: '', ...a })),
  });

  it('is silent when HireHop can cover it (to the half-penny)', () => {
    expect(excessRefundShortfall(358.68, availability(358.68, []))).toBeNull();
    expect(excessRefundShortfall(358.684, availability(358.68, []))).toBeNull();
  });

  it('with nothing free and the excess on an invoice, points at Claim — never at Reimburse', () => {
    const msg = excessRefundShortfall(1200, availability(0, [{ invoiceId: 12350, invoiceNumber: 'OT-INV-12350', amount: 1200 }]))!;
    expect(msg).toContain('nothing left on excess payment 9053');
    expect(msg).toContain('£1200.00 of it is on invoice OT-INV-12350');
    expect(msg).toContain('use Claim instead');
    expect(msg).not.toContain('Retained by Ooosh');
  });

  it('names every invoice the money went to, once each', () => {
    const msg = excessRefundShortfall(1200, availability(100, [
      { invoiceId: 12350, invoiceNumber: 'OT-INV-12350', amount: 600 },
      { invoiceId: 12351, invoiceNumber: 'OT-INV-12351', amount: 400 },
      { invoiceId: 12350, invoiceNumber: 'OT-INV-12350', amount: 100 },
    ]))!;
    expect(msg).toContain('£1100.00 of it is on invoices OT-INV-12350, OT-INV-12351.');
  });

  it('with money gone and no invoice to show for it, says it may already have been refunded', () => {
    const msg = excessRefundShortfall(1200, availability(300, []))!;
    expect(msg).toContain('only £300.00');
    expect(msg).toContain('may already have been refunded in HireHop');
  });
});
