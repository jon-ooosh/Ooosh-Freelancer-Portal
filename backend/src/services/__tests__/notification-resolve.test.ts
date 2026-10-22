/**
 * Retiring a bell once its thing is done (services/notification-resolve.ts).
 *
 * Four properties are load-bearing:
 *
 *   1. **Only bells of the given type.** The requester's "Time off approved"
 *      bell sits on the SAME leave request as the approvers' "X has requested
 *      holiday" bells. Clearing by row alone would swallow it before they saw
 *      it — so the type is part of the match, and the leave wrapper passes
 *      `follow_up`, never `system`.
 *   2. **For everyone, read AND done.** No user filter; `is_read` and
 *      `acknowledged_at` both set, so the blue dot goes and the Inbox treats
 *      it as Done. Already-done bells are left alone.
 *   3. **Every affected person's open bell is told**, once each, with their
 *      own ids — so the count drops without a reload.
 *   4. **It never throws.** The request has already been approved; a bell
 *      left lit is not a reason to report the approval as failed.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/socket', () => ({ emitToUser: jest.fn() }));
// staff-notifications imports the email service at load; nothing here sends.
jest.mock('../email-service', () => ({ emailService: {}, default: {} }));

import { query } from '../../config/database';
import { emitToUser } from '../../config/socket';
import { resolveActionBells } from '../notification-resolve';
import { retireLeaveRequestBells } from '../staff-notifications';

const mockQuery = query as jest.MockedFunction<any>;
const mockEmit = emitToUser as jest.MockedFunction<typeof emitToUser>;

const REQUEST_ID = '6a1e3c55-0d7b-4f62-9a35-2f7c1b8e4d90';
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

  it('tells each affected person once, with their own bell ids', async () => {
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
    expect(mockEmit).toHaveBeenCalledWith(JON, 'notifications_resolved', { ids: ['n1', 'n3'] });
    expect(mockEmit).toHaveBeenCalledWith(WILL, 'notifications_resolved', { ids: ['n2'] });
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

describe('retireLeaveRequestBells', () => {
  it('retires only the approvers\' follow_up bells, never the requester\'s system bell', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await retireLeaveRequestBells(REQUEST_ID);
    expect(mockQuery.mock.calls[0][1]).toEqual(['staff_leave_request', REQUEST_ID, 'follow_up']);
  });
});
