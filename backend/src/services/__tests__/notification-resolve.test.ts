/**
 * Retiring a bell once its thing is done (services/notification-resolve.ts).
 *
 * Properties that are load-bearing:
 *
 *   1. **Only bells of the given type.** The requester's "Time off approved"
 *      bell sits on the SAME leave request as the approvers' "X has requested
 *      holiday" bells. Clearing by row alone would swallow it before they saw
 *      it — so the type is part of the match, and the leave / overtime / WFH
 *      wrappers pass `follow_up`, never `system`.
 *   2. **For everyone, read AND done.** No user filter; `is_read` and
 *      `acknowledged_at` both set, so the blue dot goes and the Inbox treats
 *      it as Done. Already-done bells are left alone.
 *   3. **Every affected person's open bell is told**, once each, with their
 *      own ids — so the count drops without a reload.
 *   4. **It never throws.** The request has already been approved; a bell
 *      left lit is not a reason to report the approval as failed.
 *   5. **A mention is one person's.** Replying or reacting clears only the
 *      replier's own mention bells on that thread; opening the timeline marks
 *      them READ, never done, and leaves a snoozed bell alone.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/socket', () => ({ emitToUser: jest.fn() }));
// staff-notifications imports the email service at load; nothing here sends.
jest.mock('../email-service', () => ({ emailService: {}, default: {} }));

import { query } from '../../config/database';
import { emitToUser } from '../../config/socket';
import { resolveActionBells, resolveMyThreadMentions, markMentionsSeen } from '../notification-resolve';
import { retireLeaveRequestBells, retireOvertimeBells, retireWfhBells } from '../staff-notifications';

const mockQuery = query as jest.MockedFunction<any>;
const mockEmit = emitToUser as jest.MockedFunction<typeof emitToUser>;

const REQUEST_ID = '6a1e3c55-0d7b-4f62-9a35-2f7c1b8e4d90';
const INTERACTION_ID = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f';
const JOB_ID = '3b5d7f91-2c4e-4a6b-8d0f-1e3a5c7b9d2f';
const JON = '587685f2-68f0-443d-ab1a-0129dbfe8f42';
const WILL = '0f1bc4f0-9414-4837-b59b-5cf4dc022043';

function sql(i = 0): string {
  return String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');
}

beforeEach(() => {
  mockQuery.mockReset();
  mockEmit.mockReset();
});

describe('resolveActionBells', () => {
  it('marks matching bells read and done, for everyone, by row AND type', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolveActionBells({ entityType: 'staff_leave_request', entityId: REQUEST_ID, type: 'follow_up' });

    const s = sql();
    expect(s).toContain('UPDATE notifications');
    expect(s).toContain('is_read = true');
    expect(s).toContain('read_at = COALESCE(read_at, NOW())');
    expect(s).toContain('acknowledged_at = NOW()');
    expect(s).toContain('entity_type = $1');
    expect(s).toContain('entity_id = $2');
    expect(s).toContain('type = $3');
    expect(s).toContain('acknowledged_at IS NULL');
    expect(s).not.toContain('user_id =');
    expect(mockQuery.mock.calls[0][1]).toEqual(['staff_leave_request', REQUEST_ID, 'follow_up']);
  });

  it('tells each affected person once, with their own bell ids, as done', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'n1', user_id: JON },
        { id: 'n2', user_id: WILL },
        { id: 'n3', user_id: JON },
      ],
    });
    const n = await resolveActionBells({ entityType: 'staff_leave_request', entityId: REQUEST_ID, type: 'follow_up' });

    expect(n).toBe(3);
    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(mockEmit).toHaveBeenCalledWith(JON, 'notifications_resolved', { ids: ['n1', 'n3'], done: true });
    expect(mockEmit).toHaveBeenCalledWith(WILL, 'notifications_resolved', { ids: ['n2'], done: true });
  });

  it('tells nobody when there was nothing to clear', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const n = await resolveActionBells({ entityType: 'staff_leave_request', entityId: REQUEST_ID, type: 'follow_up' });
    expect(n).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws — a database failure returns 0 and tells nobody', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      resolveActionBells({ entityType: 'staff_leave_request', entityId: REQUEST_ID, type: 'follow_up' }),
    ).resolves.toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the approval wrappers retire only the approvers\' follow_up bells', () => {
  it.each([
    ['leave', retireLeaveRequestBells, 'staff_leave_request'],
    ['overtime', retireOvertimeBells, 'staff_overtime_entry'],
    ['wfh', retireWfhBells, 'staff_wfh_request'],
  ] as const)('%s', async (_kind, retire, entityType) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await retire(REQUEST_ID);
    // Never `system` — that is the requester's own outcome bell on the same row.
    expect(mockQuery.mock.calls[0][1]).toEqual([entityType, REQUEST_ID, 'follow_up']);
  });
});

describe('resolveMyThreadMentions', () => {
  it('clears only MY mention bells, on the thread the message belongs to, as done', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm1', user_id: JON }] });
    const n = await resolveMyThreadMentions(JON, INTERACTION_ID);

    const s = sql();
    expect(s).toContain('WITH RECURSIVE chain');
    expect(s).toContain('user_id = $1');
    expect(s).toContain("type = 'mention'");
    expect(s).toContain('acknowledged_at = NOW()');
    expect(s).toContain('acknowledged_at IS NULL');
    // The whole thread: its root and every reply on the root.
    expect(s).toContain('i.id = root.id OR i.parent_interaction_id = root.id');
    expect(mockQuery.mock.calls[0][1]).toEqual([JON, INTERACTION_ID]);
    expect(n).toBe(1);
    expect(mockEmit).toHaveBeenCalledWith(JON, 'notifications_resolved', { ids: ['m1'], done: true });
  });

  it('never throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(resolveMyThreadMentions(JON, INTERACTION_ID)).resolves.toBe(0);
    spy.mockRestore();
  });
});

describe('markMentionsSeen', () => {
  it('marks MY unread, unsnoozed mention bells on the record READ — never done', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm2', user_id: WILL }] });
    await markMentionsSeen(WILL, 'jobs', JOB_ID);

    const s = sql();
    expect(s).toContain('SET is_read = true, read_at = NOW()');
    expect(s).not.toContain('acknowledged_at');
    expect(s).toContain('user_id = $1');
    expect(s).toContain("type = 'mention'");
    expect(s).toContain('is_read = false');
    expect(s).toContain('snoozed_until IS NULL OR snoozed_until <= NOW()');
    expect(mockQuery.mock.calls[0][1]).toEqual([WILL, 'jobs', JOB_ID]);
    expect(mockEmit).toHaveBeenCalledWith(WILL, 'notifications_resolved', { ids: ['m2'], done: false });
  });
});
