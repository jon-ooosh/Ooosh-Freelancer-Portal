/**
 * Combine bookings — extending a hire that's OUT with a booking that hasn't started.
 *
 * The client keeps the van straight on to their next booking (HH 15322 out on hire,
 * 15323 confirmed for two days later, Oct 2026). Combine used to refuse anything past
 * pre-hire; it now takes ONE booking that's out, and that one is always kept — the
 * old scoring ranked 'dispatched' like an enquiry and would have cancelled the hire
 * whose van is out.
 *
 * Pure rule test: no database, no HireHop (mocked so importing the route opens nothing).
 */
import type { CombineCandidateFacts } from '../pipeline';

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn(), getPool: jest.fn() }));
jest.mock('../../services/hirehop-broker', () => {
  const broker = { post: jest.fn(), get: jest.fn() };
  return { __esModule: true, default: broker, hhBroker: broker };
});
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-session-secret';

// Required, not imported: an import is hoisted above the env lines.
const { assessCombine } = require('../pipeline') as typeof import('../pipeline');

function cand(job: Record<string, unknown>, extra: Partial<CombineCandidateFacts> = {}): CombineCandidateFacts {
  return {
    job: { client_id: 'client-1', hh_job_number: 1, ...job },
    hireDeposits: [],
    hireDepositTotal: 0,
    hasInvoices: false,
    excessHeld: false,
    activeQuotes: 0,
    ...extra,
  };
}

// The 15322 / 15323 shape: out since 17 Oct, next booking starts 29 Oct, both paid.
const onHire = () => cand(
  { id: 'job-15322', hh_job_number: 15322, pipeline_status: 'dispatched',
    out_date: '2026-10-17', job_date: '2026-10-17', job_end: '2026-10-28', return_date: '2026-10-29' },
  { hireDepositTotal: 500 },
);
const nextBooking = () => cand(
  { id: 'job-15323', hh_job_number: 15323, pipeline_status: 'confirmed',
    out_date: '2026-10-29', job_date: '2026-10-29', job_end: '2026-11-03', return_date: '2026-11-04' },
  { hireDepositTotal: 400 },
);

describe('assessCombine — a booking that is out on hire', () => {
  it('keeps the booking that is out and folds the next one into it', () => {
    const r = assessCombine(onHire(), nextBooking());
    expect(r.blocks).toEqual([]);
    expect(r.survivor.job.id).toBe('job-15322');
    expect(r.absorbed.job.id).toBe('job-15323');
  });

  it('keeps the booking that is out whichever page the combine was opened from', () => {
    const r = assessCombine(nextBooking(), onHire());
    expect(r.blocks).toEqual([]);
    expect(r.survivor.job.id).toBe('job-15322');
  });

  it('keeps the booking that is out even when only the other one holds a deposit', () => {
    const out = onHire();
    out.hireDepositTotal = 0;
    const r = assessCombine(nextBooking(), out);
    expect(r.survivor.job.id).toBe('job-15322');
  });

  it('refuses two bookings that are both out', () => {
    const other = nextBooking();
    other.job.pipeline_status = 'dispatched';
    const r = assessCombine(onHire(), other);
    expect(r.blocks.some(b => b.includes('Both bookings are out on hire'))).toBe(true);
  });

  it('refuses a booking that has come back', () => {
    const back = onHire();
    back.job.pipeline_status = 'returned';
    const r = assessCombine(back, nextBooking());
    expect(r.blocks.some(b => b.includes('"returned"'))).toBe(true);
  });

  it('refuses a booking that would move the start of the hire that is out', () => {
    const earlier = nextBooking();
    earlier.job.out_date = '2026-10-10';
    earlier.job.job_date = '2026-10-10';
    const r = assessCombine(onHire(), earlier);
    expect(r.blocks.some(b => b.includes("not move its start"))).toBe(true);
  });

  it('refuses when the booking being folded in holds excess money (combine never moves excess)', () => {
    const r = assessCombine(onHire(), nextBooking());
    const withExcess = nextBooking();
    withExcess.excessHeld = true;
    const r2 = assessCombine(onHire(), withExcess);
    expect(r.blocks).toEqual([]);
    expect(r2.survivor.job.id).toBe('job-15322');
    expect(r2.blocks.some(b => b.includes("can't move excess"))).toBe(true);
  });

  it('is fine when the excess is on the booking that is out', () => {
    const out = onHire();
    out.excessHeld = true;
    const r = assessCombine(nextBooking(), out);
    expect(r.blocks).toEqual([]);
    expect(r.survivor.job.id).toBe('job-15322');
  });

  it('still refuses two different clients', () => {
    const other = nextBooking();
    other.job.client_id = 'client-2';
    const r = assessCombine(onHire(), other);
    expect(r.blocks.some(b => b.includes('different clients'))).toBe(true);
  });

  it('still refuses when the booking being folded in has an invoice', () => {
    const invoiced = nextBooking();
    invoiced.hasInvoices = true;
    const r = assessCombine(onHire(), invoiced);
    expect(r.blocks.some(b => b.includes('invoice raised'))).toBe(true);
  });
});

describe('assessCombine — two pre-hire bookings (unchanged)', () => {
  it('keeps the more-committed booking', () => {
    const confirmed = cand({ id: 'a', pipeline_status: 'confirmed', job_date: '2026-11-10' });
    const enquiry = cand({ id: 'b', pipeline_status: 'new_enquiry', job_date: '2026-11-01' });
    const r = assessCombine(enquiry, confirmed);
    expect(r.blocks).toEqual([]);
    expect(r.survivor.job.id).toBe('a');
  });

  it('keeps the excess-holder', () => {
    const holder = cand({ id: 'a', pipeline_status: 'provisional', job_date: '2026-11-10' }, { excessHeld: true });
    const other = cand({ id: 'b', pipeline_status: 'confirmed', job_date: '2026-11-01' });
    const r = assessCombine(other, holder);
    expect(r.survivor.job.id).toBe('a');
  });

  it('breaks a tie on the earlier start', () => {
    const later = cand({ id: 'a', pipeline_status: 'confirmed', job_date: '2026-11-10' });
    const earlier = cand({ id: 'b', pipeline_status: 'confirmed', job_date: '2026-11-01' });
    const r = assessCombine(later, earlier);
    expect(r.survivor.job.id).toBe('b');
  });

  it('applies no start rule when neither booking is out', () => {
    const later = cand({ id: 'a', pipeline_status: 'confirmed', job_date: '2026-11-10' }, { excessHeld: true });
    const earlier = cand({ id: 'b', pipeline_status: 'confirmed', job_date: '2026-11-01' });
    const r = assessCombine(earlier, later);
    expect(r.blocks).toEqual([]);
    expect(r.survivor.job.id).toBe('a');
  });
});
