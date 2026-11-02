/**
 * Swapping a day (services/staff-swaps.ts, spec §8.2).
 *
 * The load-bearing properties:
 *
 *   1. **The day given up must be a working day with nothing on it, and the
 *      day worked instead must not be one** — anything else leaves the
 *      calendar disagreeing with itself or with the ledger.
 *   2. **Approval re-checks.** A swap can wait; holiday booked on the day
 *      being given up in the meantime must stop the approval, not be quietly
 *      orphaned on a date that is no longer a working day.
 *   3. **Every way a request stops waiting retires the approvers' bells**
 *      (approve, decline, withdraw) — the same rule as leave.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: {}, default: {} }));
jest.mock('../staff-notifications', () => ({ retireSwapRequestBells: jest.fn().mockResolvedValue(0) }));
jest.mock('../staff-company-days', () => ({ getCompanyDayOverlay: jest.fn().mockResolvedValue(new Map()) }));
jest.mock('../staff-day-status', () => ({
  ...jest.requireActual('../staff-day-status'),
  getStaffCalendar: jest.fn(),
}));

import { query } from '../../config/database';
import { getStaffCalendar, type StaffDay } from '../staff-day-status';
import { retireSwapRequestBells } from '../staff-notifications';
import { swapProblems, breakOf, decideSwap, withdrawSwap } from '../staff-swaps';

const mockQuery = query as jest.MockedFunction<any>;
const mockCalendar = getStaffCalendar as jest.MockedFunction<any>;
const mockRetire = retireSwapRequestBells as jest.MockedFunction<any>;

// The case that started it: works Saturday to Tuesday, wants Friday instead of Saturday.
const SAT = '2026-10-31';
const FRI = '2026-10-30';

const working = (date: string, extra: Partial<StaffDay> = {}): StaffDay => ({
  date, scheduledMinutes: 420, status: 'working', startTime: '09:00:00', endTime: '17:00:00',
  isException: false, ...extra,
});
const dayOff = (date: string, extra: Partial<StaffDay> = {}): StaffDay => ({
  date, scheduledMinutes: 0, status: 'not_scheduled', startTime: null, endTime: null,
  isException: false, ...extra,
});

describe('swapProblems', () => {
  it('accepts a working Saturday off and a free Friday worked instead', () => {
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: working(SAT), work: dayOff(FRI) })).toEqual([]);
  });

  it('refuses the same day twice', () => {
    expect(swapProblems({ offDate: SAT, workDate: SAT, off: working(SAT), work: working(SAT) })[0])
      .toMatch(/two different days/);
  });

  it('refuses when there is no staff record', () => {
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: undefined, work: undefined }))
      .toEqual(['There is no staff record for this person']);
  });

  it('refuses giving up a day that is not a working day', () => {
    expect(swapProblems({ offDate: FRI, workDate: SAT, off: dayOff(FRI), work: dayOff(SAT) })[0])
      .toMatch(/Fri 30 Oct isn't a normal working day/);
  });

  it('refuses giving up a day with holiday booked or still requested on it', () => {
    const booked = { ...working(SAT), status: 'leave' as const, detail: { leaveType: 'holiday' } };
    const requested = { ...working(SAT), status: 'partial' as const, pending: true };
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: booked, work: dayOff(FRI) })[0])
      .toMatch(/already has time off/);
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: requested, work: dayOff(FRI) })[0])
      .toMatch(/already has time off/);
  });

  it('refuses giving up a day already recorded as an absence, without naming it', () => {
    const absent = { ...working(SAT), status: 'absent' as const, detail: { absenceType: 'sickness' } };
    const msg = swapProblems({ offDate: SAT, workDate: FRI, off: absent, work: dayOff(FRI) })[0];
    expect(msg).toMatch(/recorded as a day off/);
    expect(msg).not.toMatch(/sick/i);
  });

  it('refuses giving up a day the office is shut', () => {
    const closed = dayOff(SAT, { companyDay: 'Christmas Day' });
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: closed, work: dayOff(FRI) })[0])
      .toMatch(/office is shut/);
  });

  it('refuses working instead on a day that is already a working day', () => {
    expect(swapProblems({ offDate: SAT, workDate: FRI, off: working(SAT), work: working(FRI) })[0])
      .toMatch(/Fri 30 Oct is already a working day/);
  });

  it('refuses working instead on a day the office is shut', () => {
    expect(swapProblems({
      offDate: SAT, workDate: FRI, off: working(SAT), work: dayOff(FRI), workCompanyDay: 'Boxing Day',
    })[0]).toMatch(/office is shut on Fri 30 Oct/);
  });

  it('refuses a day already part of another change', () => {
    expect(swapProblems({
      offDate: SAT, workDate: FRI, off: working(SAT), work: dayOff(FRI), takenDates: [FRI],
    })[0]).toMatch(/Fri 30 Oct is already part of another change/);
  });

  it('checks only what has been filled in so far', () => {
    expect(swapProblems({ offDate: SAT, off: working(SAT) })).toEqual([]);
    expect(swapProblems({ workDate: FRI, work: dayOff(FRI) })).toEqual([]);
  });
});

describe('breakOf', () => {
  it('recovers the unpaid break from the times and paid minutes', () => {
    expect(breakOf(working(SAT))).toBe(60);                                   // 09:00–17:00, 7h paid
    expect(breakOf(working(SAT, { scheduledMinutes: 480 }))).toBe(0);         // no break
  });
  it('is zero for a day that is not worked', () => {
    expect(breakOf(dayOff(FRI))).toBe(0);
    expect(breakOf(undefined)).toBe(0);
  });
});

// ── Deciding ────────────────────────────────────────────────────────────────

const SWAP_ID = '5b0f2f0e-6a43-4c2e-9d1c-2a9a4b7e3c10';
const PERSON = '0f1bc4f0-9414-4837-b59b-5cf4dc022043';
const ADMIN = '587685f2-68f0-443d-ab1a-0129dbfe8f42';

function swapRow(status = 'pending') {
  return {
    id: SWAP_ID, person_id: PERSON, person_name: 'Will Parish',
    off_date: SAT, work_date: FRI, start_time: '09:00:00', end_time: '17:00:00',
    minutes: 420, usual_minutes: 420, status, request_note: null,
    requested_at: '2026-10-22T10:00:00Z', decided_at: null, decision_note: null, decided_by_name: null,
  };
}
const sqlOf = (i: number) => String(mockQuery.mock.calls[i][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  mockQuery.mockReset();
  mockCalendar.mockReset();
  mockRetire.mockClear();
});

describe('decideSwap', () => {
  it('refuses to approve when holiday has since been booked on the day given up — and changes nothing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [swapRow()] })   // getSwap
      .mockResolvedValueOnce({ rows: [] });           // taken dates (its own rows excluded)
    mockCalendar.mockImplementation(async (from: string) => [{
      days: [from === SAT
        ? { ...working(SAT), status: 'leave', detail: { leaveType: 'holiday' } }
        : dayOff(FRI)],
    }]);

    await expect(decideSwap(SWAP_ID, 'approved', null, ADMIN)).rejects.toThrow(/can't be approved.*time off/);
    expect(mockQuery.mock.calls.some((_c: unknown, i: number) => sqlOf(i).startsWith('UPDATE'))).toBe(false);
    expect(mockRetire).not.toHaveBeenCalled();
  });

  it('approves both legs together, excluding its own rows from the re-check, and retires the bells', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [swapRow()] })             // getSwap
      .mockResolvedValueOnce({ rows: [] })                      // taken dates
      .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] }) // UPDATE both legs
      .mockResolvedValueOnce({ rows: [swapRow('approved')] });  // getSwap after
    mockCalendar.mockImplementation(async (from: string) => [{ days: [from === SAT ? working(SAT) : dayOff(FRI)] }]);

    const s = await decideSwap(SWAP_ID, 'approved', null, ADMIN);
    expect(s.status).toBe('approved');
    // The re-check leaves this swap's own legs out of "already part of another change".
    expect(mockQuery.mock.calls[1][1]).toEqual([PERSON, [SAT, FRI], SWAP_ID]);
    // One statement for the whole group, never a leg.
    expect(sqlOf(2)).toMatch(/UPDATE staff_pattern_exceptions .* WHERE swap_group_id = \$1 AND status = 'pending'/);
    expect(mockQuery.mock.calls[2][1]).toEqual([SWAP_ID, 'approved', ADMIN, null, ADMIN]);
    expect(mockRetire).toHaveBeenCalledWith(SWAP_ID);
  });

  it('declines without re-checking the days, and retires the bells', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [swapRow()] })
      .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] })
      .mockResolvedValueOnce({ rows: [swapRow('declined')] });

    await decideSwap(SWAP_ID, 'declined', 'Need you on the Saturday', ADMIN);
    expect(mockCalendar).not.toHaveBeenCalled();
    // approved_by stays empty on a decline.
    expect(mockQuery.mock.calls[1][1]).toEqual([SWAP_ID, 'declined', ADMIN, 'Need you on the Saturday', null]);
    expect(mockRetire).toHaveBeenCalledWith(SWAP_ID);
  });

  it('refuses a swap that is no longer waiting', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [swapRow('approved')] });
    await expect(decideSwap(SWAP_ID, 'approved', null, ADMIN)).rejects.toThrow(/no longer waiting/);
  });
});

describe('withdrawSwap', () => {
  it('only takes back the person’s own waiting swap, and retires the bells', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });
    await withdrawSwap(SWAP_ID, PERSON);
    expect(sqlOf(0)).toMatch(/SET status = 'withdrawn'.* WHERE swap_group_id = \$1 AND person_id = \$2 AND status = 'pending'/);
    expect(mockRetire).toHaveBeenCalledWith(SWAP_ID);
  });
  it('says so when there is nothing waiting to withdraw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(withdrawSwap(SWAP_ID, PERSON)).rejects.toThrow(/no longer waiting/);
    expect(mockRetire).not.toHaveBeenCalled();
  });
});
