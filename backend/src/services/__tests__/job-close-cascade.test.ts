/**
 * Job close cascade — the cleanup that runs when a job goes lost or cancelled.
 *
 * Job 16505 (Aug 2026) is why this exists. It was auto-lost by the 09:00
 * stale-enquiry cron on 31 Aug; both its transport quotes stayed `confirmed`
 * and kept showing as live work on Transport Ops. The cascade existed, but
 * only inside the staff-clicked `PATCH /api/pipeline/:id/status` handler —
 * the cron and the HireHop webhook each closed jobs with no cleanup at all.
 *
 * The rules worth pinning down, because two of the four callers are
 * unattended and nobody is watching them run:
 *   - a `completed` quote is never cancelled (the work happened; the
 *     freelancer is owed for it whatever the parent job's fate)
 *   - past-dated jobs email nobody — every job the auto-loser touches is
 *     past-dated, so cleaning up historic dead enquiries can't spam anyone
 *   - the Ooosh Staff placeholder on local D&C quotes is not a real person
 *     to email
 *   - resurrection is marker-gated: a quote a HUMAN cancelled stays cancelled
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../email-service', () => ({ __esModule: true, default: { send: jest.fn(async () => undefined) } }));
jest.mock('../fleet-hire-status-sync', () => ({ syncFleetHireStatus: jest.fn(async () => undefined) }));

import { query } from '../../config/database';
import emailService from '../email-service';
import {
  cascadeJobClose,
  reactivateAutoCancelledQuotes,
  LOST_QUOTE_MARKER,
  CANCELLED_QUOTE_MARKER,
} from '../job-close-cascade';

const mockQuery = query as jest.MockedFunction<any>;
const mockSend = (emailService as any).send as jest.MockedFunction<any>;

const JOB_ID = '0f1bc4f0-9414-4837-b59b-5cf4dc022043'; // job 16505
const USER_ID = '587685f2-68f0-443d-ab1a-0129dbfe8f42';

/** Collect the SQL of every query the cascade ran, for predicate assertions. */
function sqlLog(): string[] {
  return mockQuery.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' '));
}

/**
 * Drive the cascade with a scripted job row, crew list and swept-row counts.
 * Order of queries inside cascadeJobClose: job → crew → quotes → assignments → vha.
 */
function primeCascade(opts: {
  jobDate: string | null;
  jobEnd?: string | null;
  crew?: Array<{ role: string; first_name: string; last_name: string; email: string }>;
  quoteIds?: string[];
}) {
  const { jobDate, jobEnd, crew = [], quoteIds = ['q1'] } = opts;
  mockQuery.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: JOB_ID, hh_job_number: 16505, job_name: 'NH Tours', job_date: jobDate, job_end: jobEnd === undefined ? jobDate : jobEnd }] })
    .mockResolvedValueOnce({ rows: crew })
    .mockResolvedValueOnce({ rows: quoteIds.map((id) => ({ id })) })
    .mockResolvedValueOnce({ rows: [{ id: 'a1' }] })
    .mockResolvedValueOnce({ rows: [] });
}

const FUTURE = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
const PAST = '2026-08-30';

beforeEach(() => {
  mockQuery.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

describe('cascadeJobClose', () => {
  it('cancels the quotes and assignments a dead job left behind', async () => {
    primeCascade({ jobDate: FUTURE, quoteIds: ['q1', 'q2'] });
    const result = await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: USER_ID });

    expect(result.quotesCancelled).toBe(2);
    expect(result.assignmentsCancelled).toBe(1);
  });

  it('never touches a completed quote — that work happened and is owed', async () => {
    primeCascade({ jobDate: FUTURE });
    await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: USER_ID });

    const quoteUpdate = sqlLog().find((s) => s.includes('UPDATE quotes'));
    expect(quoteUpdate).toContain("status NOT IN ('cancelled', 'completed')");
  });

  it('stamps a marker on cancelled_reason so resurrection can tell it apart', async () => {
    primeCascade({ jobDate: FUTURE });
    await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: USER_ID });

    const quoteCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE quotes'));
    expect(quoteCall![1]).toContain(LOST_QUOTE_MARKER);

    primeCascade({ jobDate: FUTURE });
    await cascadeJobClose({ jobId: JOB_ID, reason: 'cancelled', actorUserId: USER_ID });
    const cancelCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE quotes'));
    expect(cancelCall![1]).toContain(CANCELLED_QUOTE_MARKER);
  });

  it('emails crew on a future job', async () => {
    primeCascade({
      jobDate: FUTURE,
      crew: [{ role: 'driver', first_name: 'Tom', last_name: 'Jones', email: 'tom@example.com' }],
    });
    const result = await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: USER_ID });

    expect(result.crewEmailed).toBe(1);
    expect(mockSend).toHaveBeenCalledWith('job_cancelled_crew', expect.objectContaining({ to: 'tom@example.com' }));
  });

  it('emails nobody on a past-dated job — the auto-loser only ever touches those', async () => {
    primeCascade({
      jobDate: PAST,
      crew: [{ role: 'driver', first_name: 'Tom', last_name: 'Jones', email: 'tom@example.com' }],
    });
    const result = await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: null });

    expect(result.crewEmailed).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still emails crew when a tour is cancelled mid-run', async () => {
    // Past start, future finish — those remaining days are real bookings and
    // the crew needs telling. Measuring on job_date alone would skip them.
    primeCascade({
      jobDate: PAST,
      jobEnd: FUTURE,
      crew: [{ role: 'driver', first_name: 'Tom', last_name: 'Jones', email: 'tom@example.com' }],
    });
    const result = await cascadeJobClose({ jobId: JOB_ID, reason: 'cancelled', actorUserId: USER_ID });

    expect(result.crewEmailed).toBe(1);
  });

  it('excludes the Ooosh Staff placeholder from the crew email list', async () => {
    primeCascade({ jobDate: FUTURE });
    await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: USER_ID });

    const crewSelect = sqlLog().find((s) => s.includes('FROM quote_assignments qa'));
    expect(crewSelect).toContain('qa.is_ooosh_crew = false');
  });

  it('accepts a null actor — cron and webhook have no logged-in user', async () => {
    primeCascade({ jobDate: PAST });
    await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: null });

    const quoteCall = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('UPDATE quotes'));
    expect(quoteCall![1]).toContain(null);
  });

  it('is a no-op on a job that does not exist', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: null });

    expect(result).toEqual({ quotesCancelled: 0, assignmentsCancelled: 0, vehicleAssignmentsCancelled: 0, crewEmailed: 0 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('swallows a DB failure — cleanup must never break the status change', async () => {
    mockQuery.mockReset();
    mockQuery.mockRejectedValue(new Error('connection lost'));
    await expect(cascadeJobClose({ jobId: JOB_ID, reason: 'lost', actorUserId: null })).resolves.toBeDefined();
  });
});

describe('reactivateAutoCancelledQuotes', () => {
  it('is marker-gated, and matches the pre-refactor reasons too', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'q1' }] });
    const result = await reactivateAutoCancelledQuotes(JOB_ID);

    expect(result.reactivatedCount).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'cancelled'");
    expect(params).toEqual([
      JOB_ID, LOST_QUOTE_MARKER, CANCELLED_QUOTE_MARKER,
      'Parent job marked lost', 'Parent job cancelled',
    ]);
  });

  it('brings quotes back as draft/todo, not at whatever status they held', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await reactivateAutoCancelledQuotes(JOB_ID);

    const sql = String(mockQuery.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain("status = 'draft'");
    expect(sql).toContain("ops_status = 'todo'");
  });

  it('does not resurrect crew assignments — re-offering stays a human decision', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'q1' }] });
    await reactivateAutoCancelledQuotes(JOB_ID);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).not.toContain('quote_assignments');
  });
});
