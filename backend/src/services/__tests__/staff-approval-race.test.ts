/**
 * Two presses of Approve at once (Oct 2026).
 *
 * approveRequest / cancelRequest / approveEntry check the status BEFORE the
 * transaction, so two presses at the same moment both pass it. Only one of
 * them can flip the row (`WHERE status = 'pending'`); the other's UPDATE
 * touches nothing. Before the fix it carried on and posted the ledger entry
 * anyway — a second holiday debit, a second refund, a second lot of banked
 * overtime. These pin that the loser writes nothing and rolls back, and that
 * the winner still does everything it did before.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
// The modules below are imported by the services under test but play no part
// in the approval; stubbed so the test needs nothing else booted.
jest.mock('../staff-day-status', () => ({
  DATE_RE: /^\d{4}-\d{2}-\d{2}$/, dateRange: jest.fn(), getStaffCalendar: jest.fn(), weekdayIndex: jest.fn(),
}));
jest.mock('../staff-balance', () => ({ getBalance: jest.fn(), postEntry: jest.fn(), ensureEntitlement: jest.fn() }));
jest.mock('../staff-notifications', () => ({
  retireLeaveRequestBells: jest.fn(async () => 0),
  retireOvertimeBells: jest.fn(async () => 0),
}));
jest.mock('../notification-resolve', () => ({ retireDoneBells: jest.fn(async () => 0) }));

import { query, getClient } from '../../config/database';
import { approveRequest, cancelRequest } from '../staff-leave';
import { approveEntry } from '../staff-overtime';
import { retireLeaveRequestBells, retireOvertimeBells } from '../staff-notifications';

const mockQuery = query as jest.MockedFunction<any>;
const mockGetClient = getClient as jest.MockedFunction<any>;

const ID = '6a1e3c55-0d7b-4f62-9a35-2f7c1b8e4d90';
const PERSON = '33333333-3333-3333-3333-333333333333';
const ADMIN = '587685f2-68f0-443d-ab1a-0129dbfe8f42';

/** A transaction client whose status UPDATE flips `flipped` rows. */
function fakeClient(flipped: number) {
  const client = {
    query: jest.fn(async (text: string) => {
      if (/^\s*UPDATE staff_(leave_requests|overtime_entries)/.test(text)) {
        return { rows: Array.from({ length: flipped }, () => ({ id: ID })) };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  mockGetClient.mockResolvedValueOnce(client);
  return client;
}

function statements(client: { query: jest.Mock }): string[] {
  return client.query.mock.calls.map((c: unknown[]) => String(c[0]).replace(/\s+/g, ' ').trim());
}

/** getRequest: the request row, then its days. */
function leaveRequest(status: string) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{
      id: ID, person_id: PERSON, person_name: 'Matt Test', leave_type: 'holiday',
      start_date: '2026-10-30', end_date: '2026-10-30', total_minutes: 420,
      status, requested_at: '2026-10-01T09:00:00Z',
    }] })
    .mockResolvedValueOnce({ rows: [{ leave_date: '2026-10-30', minutes: 420, portion: 'full' }] });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetClient.mockReset();
  (retireLeaveRequestBells as jest.Mock).mockClear();
  (retireOvertimeBells as jest.Mock).mockClear();
});

describe('approveRequest (leave)', () => {
  it('the press that loses the race debits nothing and rolls back', async () => {
    leaveRequest('pending');
    const client = fakeClient(0);
    await expect(approveRequest(ID, null, ADMIN)).rejects.toThrow('already been decided');

    const s = statements(client);
    expect(s.some((q) => q.includes('INSERT INTO staff_ledger_entries'))).toBe(false);
    expect(s).toContain('ROLLBACK');
    expect(s).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(retireLeaveRequestBells).not.toHaveBeenCalled();
  });

  it('the press that wins debits each day once, commits, and retires the bells', async () => {
    leaveRequest('pending');
    const client = fakeClient(1);
    await approveRequest(ID, null, ADMIN);

    const s = statements(client);
    expect(s.filter((q) => q.includes('INSERT INTO staff_ledger_entries'))).toHaveLength(1);
    expect(s).toContain('COMMIT');
    expect(retireLeaveRequestBells).toHaveBeenCalledWith(ID);
  });
});

describe('cancelRequest (leave)', () => {
  it('the press that loses the race gives nothing back and rolls back', async () => {
    leaveRequest('approved');
    const client = fakeClient(0);
    await expect(cancelRequest(ID, 'Plans changed', ADMIN)).rejects.toThrow('already been cancelled');

    const s = statements(client);
    expect(s.some((q) => q.includes('INSERT INTO staff_ledger_entries'))).toBe(false);
    expect(s).toContain('ROLLBACK');
  });
});

describe('approveEntry (overtime)', () => {
  function overtimeEntry() {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: ID, person_id: PERSON, person_name: 'Matt Test', work_date: '2026-10-20',
      minutes: 120, reason: 'Late return', status: 'pending', submitted_at: '2026-10-20T19:00:00Z',
    }] });
  }

  it('the press that loses the race banks nothing and rolls back', async () => {
    overtimeEntry();
    const client = fakeClient(0);
    await expect(approveEntry(ID, null, ADMIN)).rejects.toThrow('already been decided');

    const s = statements(client);
    expect(s.some((q) => q.includes('INSERT INTO staff_ledger_entries'))).toBe(false);
    expect(s).toContain('ROLLBACK');
    expect(retireOvertimeBells).not.toHaveBeenCalled();
  });

  it('the press that wins banks it once, commits, and retires the bells', async () => {
    overtimeEntry();
    const client = fakeClient(1);
    await approveEntry(ID, null, ADMIN);

    const s = statements(client);
    expect(s.filter((q) => q.includes('INSERT INTO staff_ledger_entries'))).toHaveLength(1);
    expect(s).toContain('COMMIT');
    expect(retireOvertimeBells).toHaveBeenCalledWith(ID);
  });
});
