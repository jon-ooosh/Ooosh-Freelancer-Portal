/**
 * Credit on account (docs/CREDIT-ON-ACCOUNT-SPEC.md). The database is mocked: these
 * check what the service refuses and what it writes, not the SQL itself.
 *
 * What matters most: money can only be held once the job's own invoices are raised and
 * paid (before that every payment looks "spare"); it follows the paying CLIENT, so it
 * can't be put aside for another client's job; and one amount can't be promised twice.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

import { query } from '../../config/database';
import {
  holdBlockReason, holdOnAccount, holdForPlan, reserveOnJob, unreserve, releaseHold,
  ACCOUNT_CREDIT_STATUS_SQL, AccountCreditError,
  withCreditOnAccount, creditOnAccountPhrase, listReservedForJob, reservedForJobSql,
} from '../account-credit';

const mockQuery = query as jest.MockedFunction<any>;
const USER = '11111111-1111-1111-1111-111111111111';
const SOURCE = '22222222-2222-2222-2222-222222222222';
const NEXT = '33333333-3333-3333-3333-333333333333';
const ORG = '44444444-4444-4444-4444-444444444444';

const invoice = { accruedNet: 1393, invoicedNet: 1393, netToInvoice: 0, draft: null, euTrigger: false, notReturned: false, blockers: [], ready: false };
const paidInvoice = { invoiceId: 1, number: 'OT-INV-12429', status: 3, date: '2026-11-16', gross: 1671.6, owing: 0, inXero: true, xeroId: 'x', chargeOnly: false };
/** Job 16489: £1,671.60 invoiced and paid, £68.40 left across two payments. */
const plan = (over: Record<string, unknown> = {}): any => ({
  jobId: SOURCE, hhJobNumber: 16489, cancellation: null, blockers: [], invoice, invoices: [paidInvoice], allocations: [],
  surplus: [{ depositId: 9300, amount: 38.4 }, { depositId: 9400, amount: 30 }], onAccount: null, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ac1', source_job_id: SOURCE, source_job_number: 16489, organisation_id: ORG, client_name: 'Gently Tender',
  amount: 68.4, amount_checked_at: 'now', note: null, held_by_name: 'Jon', held_at: '2026-11-18',
  status: 'held', reserved_job_id: null, reserved_job_number: null, reserved_at: null, released_at: null, released_reason: null,
  ...over,
});
const sqls = () => mockQuery.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' '));

beforeEach(() => { mockQuery.mockReset(); });

describe('effective status', () => {
  it('derives spent from the amount, and frees a reservation on a lost / cancelled job', () => {
    expect(ACCOUNT_CREDIT_STATUS_SQL).toContain("a.amount < 0.005 THEN 'spent'");
    expect(ACCOUNT_CREDIT_STATUS_SQL).toContain("rj.pipeline_status NOT IN ('lost', 'cancelled')");
  });
});

describe('holdBlockReason', () => {
  it('allows a finished, paid job with money left over', () => {
    expect(holdBlockReason(plan())).toBeNull();
  });
  it('refuses before the invoice is raised — until then every payment looks spare', () => {
    expect(holdBlockReason(plan({ invoices: [] }))).toContain('no invoice yet');
    expect(holdBlockReason(plan({ invoice: { ...invoice, netToInvoice: 200 } }))).toContain('Raise this job\'s invoice first');
    expect(holdBlockReason(plan({ invoice: { ...invoice, draft: paidInvoice } }))).toContain('Raise this job\'s invoice first');
  });
  it('refuses while the job\'s own invoice is owing or has payments still to allocate', () => {
    expect(holdBlockReason(plan({ invoices: [{ ...paidInvoice, owing: 50 }] }))).toContain('still owing');
    expect(holdBlockReason(plan({ allocations: [{ depositId: 9300, amount: 10 }] }))).toContain('still owing');
  });
  it('a cancelled job: what is left after the fee can be held, but only once the fee is invoiced', () => {
    expect(holdBlockReason(plan({ cancellation: { invoiced: false } }))).toContain('Raise the cancellation fee invoice first');
    expect(holdBlockReason(plan({ cancellation: { invoiced: true } }))).toBeNull();
    // No fee at all: there is no invoice, and that is fine for a cancellation only.
    expect(holdBlockReason(plan({ cancellation: { invoiced: true }, invoices: [] }))).toBeNull();
    expect(holdBlockReason(plan({ invoices: [] }))).toContain('no invoice yet');
  });
  it('refuses a blocked plan, nothing spare, and a second hold', () => {
    expect(holdBlockReason(plan({ blockers: ['Payment 9300 is in HireHop but OP has no record of taking it'] }))).toContain('Payment 9300');
    expect(holdBlockReason(plan({ surplus: [] }))).toContain('Nothing is unallocated');
    expect(holdBlockReason(plan({ onAccount: { id: 'ac1' } }))).toContain('already held');
  });
});

describe('holdOnAccount', () => {
  it('holds the job\'s WHOLE unallocated amount for the paying client, and notes it on the job', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ client_id: ORG }] })   // the job's client
      .mockResolvedValueOnce({ rowCount: 0 })                  // put away a finished earlier hold
      .mockResolvedValueOnce({ rows: [{ id: 'ac1' }] })        // insert
      .mockResolvedValueOnce({ rows: [row()] })                // re-read
      .mockResolvedValue({ rows: [] });                        // note
    const c = await holdOnAccount(plan(), USER, ' for the March tour ');
    expect(c.amount).toBe(68.4);
    const insert = mockQuery.mock.calls[2][1];
    expect(insert).toEqual([SOURCE, ORG, 68.4, 'for the March tour', USER]);
    expect(sqls().some((s: string) => s.includes('INSERT INTO interactions (job_id'))).toBe(true);
    // Nothing but OP's own tables.
    expect(sqls().every((s: string) => !/hirehop|xero/i.test(s))).toBe(true);
  });
  it('refuses a job with no client organisation, and writes nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ client_id: null }] });
    await expect(holdOnAccount(plan(), USER)).rejects.toThrow('no client organisation');
    expect(sqls().some((s: string) => s.includes('INSERT'))).toBe(false);
  });
  it('refuses a plan that can\'t be held without touching the database', async () => {
    await expect(holdOnAccount(plan({ invoices: [] }), USER)).rejects.toBeInstanceOf(AccountCreditError);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it('says so when someone else held it a moment ago', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ client_id: ORG }] }).mockResolvedValueOnce({ rowCount: 0 }).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(holdOnAccount(plan(), USER)).rejects.toThrow('already held');
  });
});

describe('holdForPlan', () => {
  it('brings the stored amount to what HireHop has unallocated, then answers', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [row({ amount: 30 })] });
    const h = await holdForPlan(SOURCE, 30);
    expect(mockQuery.mock.calls[0][1]).toEqual([SOURCE, 30]);
    expect(h).toMatchObject({ id: 'ac1', amount: 30, clientName: 'Gently Tender' });
  });
  it('leaves the amount alone when the plan had no live figure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await holdForPlan(SOURCE, null);
    expect(sqls().some((s: string) => s.startsWith('UPDATE'))).toBe(false);
  });
  it('never fails the plan', async () => {
    mockQuery.mockRejectedValue(new Error('relation "account_credits" does not exist'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(holdForPlan(SOURCE, 10)).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe('reserveOnJob', () => {
  const job = (over: Record<string, unknown> = {}) => ({ id: NEXT, hh_job_number: 16900, client_id: ORG, pipeline_status: 'quoting', is_internal: false, ...over });

  it('puts it aside for a live job of the same client, with a guarded update', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [job()] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row({ status: 'reserved', reserved_job_id: NEXT, reserved_job_number: 16900 })] })
      .mockResolvedValue({ rows: [] });
    const c = await reserveOnJob('ac1', NEXT, USER);
    expect(c.status).toBe('reserved');
    const update = sqls()[2];
    expect(update).toContain("a.status = 'held' AND a.amount >= 0.005");
    expect(update).toContain('a.reserved_job_id IS NULL');
  });
  it('refuses another client\'s job — the money follows the payer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [job({ client_id: 'someone-else' })] });
    await expect(reserveOnJob('ac1', NEXT, USER)).rejects.toThrow('different client');
    expect(sqls().some((s: string) => s.startsWith('UPDATE'))).toBe(false);
  });
  it('refuses the job the money is on, a closed job, and money already promised or gone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [job({ id: SOURCE })] });
    await expect(reserveOnJob('ac1', SOURCE, USER)).rejects.toThrow('already on');
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [job({ pipeline_status: 'cancelled' })] });
    await expect(reserveOnJob('ac1', NEXT, USER)).rejects.toThrow('closed');
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'reserved', reserved_job_id: 'other', reserved_job_number: 16950 })] });
    await expect(reserveOnJob('ac1', NEXT, USER)).rejects.toThrow('job 16950');
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'spent', amount: 0 })] });
    await expect(reserveOnJob('ac1', NEXT, USER)).rejects.toThrow('no longer on account');
  });
  it('loses cleanly when two people reserve at once', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [job()] }).mockResolvedValueOnce({ rowCount: 0 });
    await expect(reserveOnJob('ac1', NEXT, USER)).rejects.toThrow('just put it aside');
  });
});

describe('unreserve / releaseHold', () => {
  it('only takes a live reservation off', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await expect(unreserve('ac1', USER)).rejects.toThrow('isn\'t put aside');
  });
  it('stop holding needs a reason, clears any reservation, and notes both jobs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await expect(releaseHold('ac1', USER, '  ')).rejects.toThrow('Say why');
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [row({ status: 'reserved', reserved_job_id: NEXT, reserved_job_number: 16900 })] })
      .mockResolvedValue({ rows: [row({ status: 'released' })] });
    await releaseHold('ac1', USER, 'refunding it instead');
    expect(sqls()[1]).toContain("status = 'released'");
    expect(sqls()[1]).toContain('reserved_job_id = NULL');
    expect(sqls().filter((s: string) => s.includes('INSERT INTO interactions')).length).toBe(2);
  });
});

describe('what a job has put aside for it', () => {
  const c = (amount: number, n: number | null = 16489) => ({ id: `c${amount}`, amount, source_job_id: SOURCE, source_job_number: n });

  it('covers the balance up to what is owed and says what is left to ask for', () => {
    expect(withCreditOnAccount(500, [c(68.4)])).toEqual({ total: 68.4, covers: 68.4, toPay: 431.6 });
  });
  it('never covers more than the job owes — the rest stays on account', () => {
    expect(withCreditOnAccount(50, [c(68.4)])).toEqual({ total: 68.4, covers: 50, toPay: 0 });
    expect(withCreditOnAccount(0, [c(68.4)])).toEqual({ total: 68.4, covers: 0, toPay: 0 });
    // An overpaid job (negative balance) is not made "more overpaid" by it.
    expect(withCreditOnAccount(-20, [c(68.4)])).toEqual({ total: 68.4, covers: 0, toPay: 0 });
  });
  it('adds several credits, to the penny', () => {
    expect(withCreditOnAccount(100, [c(33.33), c(33.33), c(33.33)])).toEqual({ total: 99.99, covers: 99.99, toPay: 0.01 });
    expect(withCreditOnAccount(250, [])).toEqual({ total: 0, covers: 0, toPay: 250 });
  });
  it('names where the money is', () => {
    expect(creditOnAccountPhrase([c(68.4)])).toBe('£68.40 on account from job 16489');
    expect(creditOnAccountPhrase([c(68.4), c(30, 16502)])).toBe('£98.40 on account from jobs 16489 and 16502');
    expect(creditOnAccountPhrase([c(10, null)])).toBe('£10.00 on account from an earlier job');
  });
  it('a balance read never fails over it', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(listReservedForJob(NEXT)).resolves.toEqual([]);
    warn.mockRestore();
  });
  it('the SQL sum counts only live holds with money left', () => {
    const sql = reservedForJobSql('jf.job_id');
    expect(sql).toContain('a.reserved_job_id = jf.job_id');
    expect(sql).toContain("a.status = 'held' AND a.amount >= 0.005");
  });
});
