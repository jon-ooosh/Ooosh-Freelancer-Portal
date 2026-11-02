/**
 * Lost / Cancelled requirement cleanup — the forward pass.
 *
 * Three properties here are load-bearing and all three were only true by
 * accident of statement order in the two inline copies this replaced:
 *
 *   1. **Event triggers fire BEFORE the sweep.** A reminder set to fire "when
 *      this job is lost" is a `reminder` requirement like any other, so a
 *      sweep-first ordering cancels it before it ever fires. That's silent —
 *      nobody gets the reminder and nothing logs a problem.
 *   2. **The marker separator is exact.** `requirement-cleanup.ts` strips
 *      these on resurrection by literal string match (`E'\n[Auto-cancelled:
 *      job marked lost]'` vs `' [Cancelled]'`), so getting the separator wrong
 *      leaves residue in `notes` forever.
 *   3. **An unassigned reminder on an unattended path goes to the admins.**
 *      The cron and the HireHop webhook have no logged-in user, so
 *      `assigned_to || req.user.id` — what both inline copies did — would
 *      insert a NULL user_id and fire the reminder into nobody's inbox.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../email-service', () => ({ __esModule: true, default: { sendRaw: jest.fn(async () => undefined) } }));
jest.mock('../../config/app-urls', () => ({ getFrontendUrl: () => 'https://staff.example' }));

import { query } from '../../config/database';
import emailService from '../email-service';
import { closeJobRequirements, fireEventTriggeredReminders } from '../requirement-close-sweep';

const mockQuery = query as jest.MockedFunction<any>;
const mockSendRaw = (emailService as any).sendRaw as jest.MockedFunction<any>;

const JOB_ID = '0f1bc4f0-9414-4837-b59b-5cf4dc022043';
const USER_ID = '587685f2-68f0-443d-ab1a-0129dbfe8f42';

/** SQL of each query in order, whitespace-collapsed. */
function sqlLog(): string[] {
  return mockQuery.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' '));
}
function indexOfSql(fragment: string): number {
  return sqlLog().findIndex((s) => s.includes(fragment));
}
function callWithSql(fragment: string): any[] | undefined {
  return mockQuery.mock.calls.find((c: any[]) => String(c[0]).replace(/\s+/g, ' ').includes(fragment));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockSendRaw.mockReset();
  mockSendRaw.mockResolvedValue(undefined);
  // Default: nothing anywhere. Individual tests override in order.
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('closeJobRequirements ordering', () => {
  it('flags keeps, then fires triggers, then sweeps — in that order', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'keep1' }] })                       // flag keeps
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'Chase deposit refund', assigned_to: USER_ID, notes: null, delivery_method: 'notification', job_id: JOB_ID } ] }) // triggered select
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours', client_name: null, hh_job_number: 16505 }] }) // job row
      .mockResolvedValueOnce({ rows: [] })                                       // notification insert
      .mockResolvedValueOnce({ rows: [] })                                       // self-mark done
      .mockResolvedValueOnce({ rows: [{ id: 's1' }, { id: 's2' }] });            // sweep

    const res = await closeJobRequirements({
      jobId: JOB_ID, reason: 'lost', keepRequirementIds: ['keep1'], actorUserId: USER_ID,
    });

    expect(res).toEqual({ kept: 1, triggersFired: 1, swept: 2 });

    const keepAt = indexOfSql('keep_after_close = true');
    const triggerAt = indexOfSql("requirement_type = 'reminder'");
    const doneAt = indexOfSql("SET status = 'done'");
    const sweepAt = indexOfSql("SET status = 'cancelled'");

    expect(keepAt).toBeGreaterThanOrEqual(0);
    expect(keepAt).toBeLessThan(triggerAt);
    // The reminder self-marks done BEFORE the sweep, which is what stops the
    // sweep cancelling a reminder that was supposed to fire on this status.
    expect(doneAt).toBeLessThan(sweepAt);
  });

  it('skips the keep pass entirely when there is no keep-list (unattended paths)', async () => {
    await closeJobRequirements({ jobId: JOB_ID, reason: 'lost', actorUserId: null });
    expect(indexOfSql('keep_after_close = true')).toBe(-1);
  });

  it('still respects rows already flagged keep_after_close when nothing is passed', async () => {
    await closeJobRequirements({ jobId: JOB_ID, reason: 'lost', actorUserId: null });
    const sweep = sqlLog().find((s) => s.includes("SET status = 'cancelled'"));
    expect(sweep).toContain('keep_after_close = false');
    expect(sweep).toContain("status NOT IN ('done', 'cancelled')");
  });
});

describe('sweep markers', () => {
  it('writes the lost marker with a NEWLINE separator', async () => {
    await closeJobRequirements({ jobId: JOB_ID, reason: 'lost', actorUserId: null });
    const call = callWithSql("SET status = 'cancelled'");
    expect(call![1]).toContain('\n[Auto-cancelled: job marked lost]');
  });

  it('writes the cancelled marker with a LEADING SPACE separator', async () => {
    // requirement-cleanup.ts strips exactly ' [Cancelled]' — a newline here
    // would survive every resurrection as residue in notes.
    await closeJobRequirements({ jobId: JOB_ID, reason: 'cancelled', actorUserId: null });
    const call = callWithSql("SET status = 'cancelled'");
    expect(call![1]).toContain(' [Cancelled]');
    expect(call![1]).not.toContain('\n[Cancelled]');
  });

  it('uses a reason-specific kept-alive marker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'k' }] });
    await closeJobRequirements({
      jobId: JOB_ID, reason: 'cancelled', keepRequirementIds: ['k'], actorUserId: USER_ID,
    });
    const call = callWithSql('keep_after_close = true');
    // params are [ids, jobId, markerText]
    expect(call![1][2]).toContain('[Kept alive after job cancelled]');
  });
});

describe('fireEventTriggeredReminders', () => {
  it('matches only reminders whose event_trigger is this status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await fireEventTriggeredReminders(JOB_ID, 'lost', USER_ID);

    const [sqlText, params] = mockQuery.mock.calls[0];
    expect(String(sqlText)).toContain('jr.event_trigger = $2');
    expect(params).toEqual([JOB_ID, 'lost']);
  });

  it('falls back to every active admin/manager when unassigned and unattended', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: null, notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'admin1' }, { id: 'admin2' }] })  // admin lookup
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', null);

    const adminLookup = sqlLog().find((s) => s.includes("role IN ('admin', 'manager')"));
    expect(adminLookup).toBeDefined();
    expect(adminLookup).toContain('is_active = true');

    // One notification per admin — not one NULL-user row.
    const inserts = mockQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('INSERT INTO notifications'));
    expect(inserts).toHaveLength(2);
    expect(inserts.map((c: any[]) => c[1][0])).toEqual(['admin1', 'admin2']);
  });

  it('sends a "Me" reminder (no assignee) to its CREATOR, not the actor', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: null, created_by: 'creator1', notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValue({ rows: [] });

    // USER_ID is whoever marked the job lost — irrelevant to whose reminder it is.
    await fireEventTriggeredReminders(JOB_ID, 'lost', USER_ID);

    expect(sqlLog().find((s) => s.includes("role IN ('admin', 'manager')"))).toBeUndefined();
    const insert = callWithSql('INSERT INTO notifications');
    expect(insert![1][0]).toBe('creator1');
  });

  it('sends a "Me" reminder to its creator even on an unattended path', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: null, created_by: 'creator1', notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', null);

    // No admin broadcast — the creator is a better answer than everyone.
    expect(sqlLog().find((s) => s.includes("role IN ('admin', 'manager')"))).toBeUndefined();
    const inserts = mockQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('INSERT INTO notifications'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1][0]).toBe('creator1');
  });

  it('prefers the assignee over the creator', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: 'assignee1', created_by: 'creator1', notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', null);

    const insert = callWithSql('INSERT INTO notifications');
    expect(insert![1][0]).toBe('assignee1');
  });

  it('selects created_by so the fallback has something to read', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await fireEventTriggeredReminders(JOB_ID, 'lost', USER_ID);
    expect(String(mockQuery.mock.calls[0][0])).toContain('jr.created_by');
  });

  it('prefers the assignee, and never looks up admins when there is one', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: 'assignee1', notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', null);

    expect(sqlLog().find((s) => s.includes("role IN ('admin', 'manager')"))).toBeUndefined();
    const insert = callWithSql('INSERT INTO notifications');
    expect(insert![1][0]).toBe('assignee1');
  });

  it('emails on delivery_method both, and not on notification-only', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: USER_ID, notes: null, delivery_method: 'both', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValueOnce({ rows: [] })                                          // notification
      .mockResolvedValueOnce({ rows: [{ email: 'jon@example.com', first_name: 'Jon' }] }) // user lookup
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', USER_ID);
    expect(mockSendRaw).toHaveBeenCalledWith(expect.objectContaining({ to: 'jon@example.com' }));

    mockQuery.mockReset();
    mockSendRaw.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'r1', custom_label: 'X', assigned_to: USER_ID, notes: null, delivery_method: 'notification', job_id: JOB_ID }] })
      .mockResolvedValueOnce({ rows: [{ job_name: 'NH Tours' }] })
      .mockResolvedValue({ rows: [] });

    await fireEventTriggeredReminders(JOB_ID, 'lost', USER_ID);
    expect(mockSendRaw).not.toHaveBeenCalled();
  });

  it('is usable for confirmed, which fires triggers without any sweep', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await fireEventTriggeredReminders(JOB_ID, 'confirmed', USER_ID);

    expect(mockQuery.mock.calls[0][1]).toEqual([JOB_ID, 'confirmed']);
    expect(indexOfSql("SET status = 'cancelled'")).toBe(-1);
  });

  it('swallows a DB failure — cleanup must never break the status change', async () => {
    mockQuery.mockReset();
    mockQuery.mockRejectedValue(new Error('connection lost'));

    await expect(
      closeJobRequirements({ jobId: JOB_ID, reason: 'lost', keepRequirementIds: ['k'], actorUserId: null })
    ).resolves.toEqual({ kept: 0, triggersFired: 0, swept: 0 });
  });
});
