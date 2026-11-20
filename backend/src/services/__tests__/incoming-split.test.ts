/**
 * "Split across jobs" for one Wise transfer (services/incoming-split.ts). The money
 * rules: every line checked before anything is written; a line that looks already
 * recorded is refused unless linked or "record anyway"; a failed line stops the run and
 * leaves the lines before it recorded; the transfer is done only at the exact total.
 * Fixture: #2501093374, £2,363.64 from O I B RE, "MUTATIONS X 3".
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../record-payment', () => ({ recordPayment: jest.fn() }));
jest.mock('../wise-incoming', () => ({
  AMOUNT_TOLERANCE: 0.02,
  findAlreadyRecordedPayment: jest.fn(async () => null),
  describeExisting: (e: { id: string }) => `already recorded as ${e.id}`,
  wisePaymentReference: () => 'Wise #2501093374 - MUTATIONS X 3',
}));

import { query, getClient } from '../../config/database';
import { recordPayment } from '../record-payment';
import { findAlreadyRecordedPayment } from '../wise-incoming';
import { splitIncomingPayment } from '../incoming-split';
import { checkSplitLines, describeSplit } from '../incoming-split-rules';

const mQuery = query as jest.Mock;
const mGetClient = getClient as jest.Mock;
const mRecord = recordPayment as jest.Mock;
const mFind = findAlreadyRecordedPayment as jest.Mock;

const actor = { id: 'user-1', label: 'jon@example.com' };

/** A tiny in-memory stand-in for the three tables the split touches. */
function fakeDb(opts: { status?: string; amount?: string; currency?: string; lockFree?: boolean; payments?: Record<string, { job_id: string; amount: string; taken?: boolean }> } = {}) {
  const incoming = { id: 'inc-1', status: opts.status || 'unmatched', amount: opts.amount || '2363.64', currency: opts.currency || 'GBP',
    received_at: '2026-11-17T16:35:13Z', transfer_number: '2501093374', reference: 'MUTATIONS X 3', match_notes: null as string | null,
    match_method: null as string | null };
  const splits: Array<{ id: string; hh_job_number: number; payment_type: string; amount: number; status: string; job_payment_id: string | null; error?: string }> = [];
  const jobs: Record<number, string> = { 16901: 'job-a', 16902: 'job-b', 16903: 'job-c' };
  let seq = 0;

  mGetClient.mockResolvedValue({
    query: jest.fn(async (sql: string) => (sql.includes('pg_try_advisory_lock') ? { rows: [{ ok: opts.lockFree !== false }] } : { rows: [] })),
    release: jest.fn(),
  });
  mQuery.mockImplementation(async (sql: string, p: unknown[] = []) => {
    if (sql.includes('SELECT * FROM incoming_bank_payments')) return { rows: [incoming] };
    if (sql.includes("SET status = 'failed'") && sql.includes("status = 'recording'")) return { rows: [] };
    if (sql.includes('SELECT hh_job_number, payment_type, amount, status FROM incoming_bank_payment_splits')) {
      const statuses = p[1] as string[];
      return { rows: splits.filter(s => statuses.includes(s.status)).map(s => ({ ...s, amount: String(s.amount) })) };
    }
    if (sql.includes('FROM jobs WHERE hh_job_number = ANY')) {
      return { rows: (p[0] as number[]).filter(n => jobs[n]).map(n => ({ id: jobs[n], hh_job_number: n })) };
    }
    if (sql.includes('FROM job_payments jp WHERE jp.id = $1')) {
      const x = opts.payments?.[p[0] as string];
      return { rows: x ? [{ id: p[0], job_id: x.job_id, amount: x.amount, hirehop_deposit_id: 999, taken: !!x.taken }] : [] };
    }
    if (sql.includes("VALUES ($1, $2, $3, $4, $5, 'linked'")) {
      splits.push({ id: `s${++seq}`, hh_job_number: p[2] as number, payment_type: p[3] as string, amount: p[4] as number, status: 'linked', job_payment_id: p[5] as string });
      return { rows: [] };
    }
    if (sql.includes("VALUES ($1, $2, $3, $4, $5, 'recording'")) {
      const id = `s${++seq}`;
      splits.push({ id, hh_job_number: p[2] as number, payment_type: p[3] as string, amount: p[4] as number, status: 'recording', job_payment_id: null });
      return { rows: [{ id }] };
    }
    if (sql.includes("SET status = 'recorded', job_payment_id")) {
      const s = splits.find(x => x.id === p[0])!; s.status = 'recorded'; s.job_payment_id = p[1] as string; return { rows: [] };
    }
    if (sql.includes("UPDATE incoming_bank_payment_splits SET status = 'failed'")) {
      const s = splits.find(x => x.id === p[0])!; s.status = 'failed'; s.error = p[1] as string; return { rows: [] };
    }
    if (sql.includes("SET status = 'recorded', match_method = 'split'")) {
      incoming.status = 'recorded'; incoming.match_method = 'split'; incoming.match_notes = p[2] as string; return { rows: [] };
    }
    if (sql.includes('UPDATE incoming_bank_payments SET match_notes')) { incoming.match_notes = p[1] as string; return { rows: [] }; }
    return { rows: [] };
  });
  return { incoming, splits };
}

const ok = (id: string) => ({ status: 200, body: { data: { id, hirehop_deposit_id: 1 }, hh_push_error: null } });
const three = [
  { hh_job_number: 16901, payment_type: 'deposit' as const, amount: 787.88 },
  { hh_job_number: 16902, payment_type: 'deposit' as const, amount: 787.88 },
  { hh_job_number: 16903, payment_type: 'deposit' as const, amount: 787.88 },
];

beforeEach(() => { jest.clearAllMocks(); mFind.mockResolvedValue(null); });

describe('checkSplitLines', () => {
  it('accepts lines that add up to the penny', () => {
    expect(checkSplitLines(2363.64, [], three)).toBeNull();
    expect(checkSplitLines(99.99, [], [33.33, 33.33, 33.33].map(a => ({ hh_job_number: 1, payment_type: 'deposit' as const, amount: a })))).toBeNull();
  });
  it('counts lines already done', () => {
    expect(checkSplitLines(2363.64, [787.88, 787.88], [three[2]])).toBeNull();
  });
  it('refuses a total a penny out, and says what is left', () => {
    expect(checkSplitLines(2363.64, [], [{ ...three[0], amount: 787.87 }, three[1], three[2]])).toMatch(/£2,?363\.64|2363\.64/);
    expect(checkSplitLines(2363.64, [787.88], three)).toMatch(/1575\.76 of the £2363\.64 is left/);
  });
  it('refuses fractions of a penny, empty and duplicate links', () => {
    expect(checkSplitLines(10, [], [{ hh_job_number: 1, payment_type: 'deposit', amount: 10.005 }])).toMatch(/pounds and pence/);
    expect(checkSplitLines(10, [], [])).toMatch(/at least one/);
    expect(checkSplitLines(20, [], [
      { hh_job_number: 1, payment_type: 'deposit', amount: 10, decision: 'link', link_payment_id: 'p1' },
      { hh_job_number: 2, payment_type: 'deposit', amount: 10, decision: 'link', link_payment_id: 'p1' },
    ])).toMatch(/same payment/);
  });
  it('describes a finished split, leaving out failed lines', () => {
    expect(describeSplit([
      { hh_job_number: 16901, payment_type: 'deposit', amount: 787.88, status: 'recorded' },
      { hh_job_number: 16902, payment_type: 'excess', amount: 100, status: 'linked' },
      { hh_job_number: 16903, payment_type: 'deposit', amount: 5, status: 'failed' },
    ])).toBe('#16901 hire £787.88 · #16902 excess £100.00 (already recorded, linked)');
  });
});

describe('splitIncomingPayment', () => {
  it('records every line through record-payment and finishes the transfer', async () => {
    const { incoming, splits } = fakeDb();
    mRecord.mockResolvedValueOnce(ok('p1')).mockResolvedValueOnce(ok('p2')).mockResolvedValueOnce(ok('p3'));
    const r = await splitIncomingPayment('inc-1', three, actor);
    expect(r).toMatchObject({ ok: true, complete: true });
    expect(mRecord).toHaveBeenCalledTimes(3);
    expect(mRecord.mock.calls[0][0]).toBe('job-a');
    expect(mRecord.mock.calls[0][1]).toMatchObject({ amount: 787.88, payment_method: 'wise_bacs', push_to_hirehop: true, payment_reference: 'Wise #2501093374 - MUTATIONS X 3 (part 1 of 3)' });
    expect(splits.map(s => s.status)).toEqual(['recorded', 'recorded', 'recorded']);
    expect(incoming.status).toBe('recorded');
    expect(incoming.match_notes).toContain('#16903 hire £787.88');
  });

  it('writes NOTHING when the lines do not add up', async () => {
    const { splits } = fakeDb();
    const r = await splitIncomingPayment('inc-1', [three[0], three[1]], actor);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(mRecord).not.toHaveBeenCalled();
    expect(splits).toHaveLength(0);
  });

  it('writes NOTHING when a job is not in OP', async () => {
    fakeDb();
    const r = await splitIncomingPayment('inc-1', [three[0], three[1], { ...three[2], hh_job_number: 99999 }], actor);
    expect(r).toMatchObject({ ok: false, status: 400, error: 'No job #99999 in OP' });
    expect(mRecord).not.toHaveBeenCalled();
  });

  it('refuses money that looks already recorded — by line, before anything is written', async () => {
    const { splits } = fakeDb();
    mFind.mockImplementation(async (jobId: string) => (jobId === 'job-b' ? { id: 'hand-1', amount: 787.88 } : null));
    const r = await splitIncomingPayment('inc-1', three, actor);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts?.[0]).toMatchObject({ index: 1, hh_job_number: 16902 });
    }
    expect(mRecord).not.toHaveBeenCalled();
    expect(splits).toHaveLength(0);
  });

  it('links the hand-recorded payments instead of recording them again (the O I B RE case)', async () => {
    const { incoming, splits } = fakeDb({ payments: {
      'hand-1': { job_id: 'job-a', amount: '787.88' }, 'hand-2': { job_id: 'job-b', amount: '787.88' }, 'hand-3': { job_id: 'job-c', amount: '787.88' },
    } });
    const r = await splitIncomingPayment('inc-1', three.map((l, i) => ({ ...l, decision: 'link' as const, link_payment_id: `hand-${i + 1}` })), actor);
    expect(r).toMatchObject({ ok: true, complete: true });
    expect(mRecord).not.toHaveBeenCalled();
    expect(splits.map(s => s.status)).toEqual(['linked', 'linked', 'linked']);
    expect(incoming.status).toBe('recorded');
  });

  it('refuses a link to a payment on another job, or already taken', async () => {
    fakeDb({ payments: { 'hand-1': { job_id: 'job-b', amount: '787.88' }, 'hand-2': { job_id: 'job-b', amount: '787.88', taken: true } } });
    const wrongJob = await splitIncomingPayment('inc-1', [{ ...three[0], decision: 'link', link_payment_id: 'hand-1' }, three[1], three[2]], actor);
    expect(wrongJob).toMatchObject({ ok: false, status: 400 });
    const taken = await splitIncomingPayment('inc-1', [three[0], { ...three[1], decision: 'link', link_payment_id: 'hand-2' }, three[2]], actor);
    expect(taken).toMatchObject({ ok: false, status: 400 });
    expect(mRecord).not.toHaveBeenCalled();
  });

  it('stops at a failed line: the ones before stay recorded, the transfer stays in the queue', async () => {
    const { incoming, splits } = fakeDb();
    mRecord.mockResolvedValueOnce(ok('p1')).mockResolvedValueOnce({ status: 400, body: { error: 'HireHop said no' } });
    const r = await splitIncomingPayment('inc-1', three, actor);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.lines?.map(l => l.status)).toEqual(['recorded', 'failed', 'not_started']);
    expect(mRecord).toHaveBeenCalledTimes(2);
    expect(splits.map(s => s.status)).toEqual(['recorded', 'failed']);
    expect(incoming.status).toBe('unmatched');
    expect(incoming.match_notes).toMatch(/£1575\.76 left/);

    // Finishing it needs only what is left — the failed line doesn't count.
    mRecord.mockResolvedValueOnce(ok('p2')).mockResolvedValueOnce(ok('p3'));
    const again = await splitIncomingPayment('inc-1', [three[1], three[2]], actor);
    expect(again).toMatchObject({ ok: true, complete: true });
    expect(incoming.status).toBe('recorded');
  });

  it('marks a line failed (and says check the job) when recording throws', async () => {
    const { splits } = fakeDb();
    mRecord.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await splitIncomingPayment('inc-1', three, actor);
    expect(r.ok).toBe(false);
    expect(splits[0].status).toBe('failed');
    expect(splits[0].error).toMatch(/check job #16901/);
  });

  it('refuses while someone else is splitting, and once the transfer is settled', async () => {
    fakeDb({ lockFree: false });
    expect(await splitIncomingPayment('inc-1', three, actor)).toMatchObject({ ok: false, status: 409 });
    fakeDb({ status: 'recorded' });
    expect(await splitIncomingPayment('inc-1', three, actor)).toMatchObject({ ok: false, status: 400 });
    fakeDb({ currency: 'EUR' });
    expect(await splitIncomingPayment('inc-1', three, actor)).toMatchObject({ ok: false, status: 400 });
    expect(mRecord).not.toHaveBeenCalled();
  });
});
