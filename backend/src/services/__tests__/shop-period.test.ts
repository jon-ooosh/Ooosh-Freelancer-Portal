/**
 * Which week a sale belongs to.
 *
 * The weekly shop job is invoiced as a unit, so a date landing in the wrong
 * week splits one day's takings across two invoices — quiet, and a pain to
 * unpick afterwards. Sunday is the trap: it belongs to the week that STARTED
 * six days ago, not the one about to begin.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

import { query } from '../../config/database';
import { weekStart, londonDate, getShopPeriodForSale } from '../shop-period';

const mockQuery = query as jest.Mock;

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('weekStart', () => {
  it('returns the Monday itself unchanged', () => {
    expect(weekStart(d('2026-09-28'))).toBe('2026-09-28');
  });

  it('maps every weekday back to that Monday', () => {
    expect(weekStart(d('2026-09-29'))).toBe('2026-09-28');  // Tue
    expect(weekStart(d('2026-09-30'))).toBe('2026-09-28');  // Wed
    expect(weekStart(d('2026-10-01'))).toBe('2026-09-28');  // Thu
    expect(weekStart(d('2026-10-02'))).toBe('2026-09-28');  // Fri
    expect(weekStart(d('2026-10-03'))).toBe('2026-09-28');  // Sat
  });

  it('puts SUNDAY in the week that started six days earlier', () => {
    // The off-by-one that would split a Sunday's takings from the Saturday's.
    expect(weekStart(d('2026-10-04'))).toBe('2026-09-28');
  });

  it('starts a new week on the following Monday', () => {
    expect(weekStart(d('2026-10-05'))).toBe('2026-10-05');
  });

  it('crosses a month boundary', () => {
    expect(weekStart(d('2026-11-01'))).toBe('2026-10-26');  // a Sunday
  });

  it('crosses a year boundary', () => {
    expect(weekStart(d('2027-01-01'))).toBe('2026-12-28');  // Friday → Monday
  });

  it('is unaffected by the time of day', () => {
    expect(weekStart(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-28');
    expect(weekStart(new Date('2026-09-30T00:00:00Z'))).toBe('2026-09-28');
  });
});

describe('weekStart uses the UK date, not UTC', () => {
  it('puts 00:30 BST on a Monday in the NEW week (still Sunday in UTC)', () => {
    // 2026-10-04T23:30Z is Monday 5 Oct, 00:30 in London.
    expect(londonDate(new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
    expect(weekStart(new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-05');
  });

  it('keeps 23:30 BST on a Sunday in the OLD week', () => {
    expect(weekStart(new Date('2026-10-04T22:30:00Z'))).toBe('2026-09-28');
  });

  it('agrees with UTC in winter (GMT)', () => {
    // Sunday 29 Nov 2026, 23:59 GMT.
    expect(weekStart(new Date('2026-11-29T23:59:00Z'))).toBe('2026-11-23');
    expect(weekStart(new Date('2026-11-30T00:00:00Z'))).toBe('2026-11-30');
  });
});

describe('getShopPeriodForSale — the week a sale was RUNG UP in', () => {
  beforeEach(() => mockQuery.mockReset());

  const row = { id: 'p-last', period_start: '2026-09-28', period_end: '2026-10-04', hh_job_number: 16750 };

  it("puts a Sunday 23:59 sale that drains on Monday on LAST week's job", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const p = await getShopPeriodForSale(new Date('2026-10-04T22:59:00Z'), new Date('2026-10-04T23:01:00Z'));
    expect(p.hhJobNumber).toBe(16750);
    expect(mockQuery.mock.calls[0][0]).toContain('close_state IS NULL');
    expect(mockQuery.mock.calls[0][1]).toEqual(['2026-09-28']);
  });

  it('falls through to the current week when last week is closing or has no job', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                                   // own week: closing / none
      .mockResolvedValueOnce({ rows: [{ ...row, id: 'p-now', period_start: '2026-10-05', period_end: '2026-10-11', hh_job_number: 16800 }] });
    const p = await getShopPeriodForSale(new Date('2026-10-04T22:59:00Z'), new Date('2026-10-05T09:00:00Z'));
    expect(p.hhJobNumber).toBe(16800);
    expect(mockQuery.mock.calls[1][1]).toEqual(['2026-10-05']);
  });

  it("doesn't look back at all for a sale rung up this week", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, id: 'p-now', period_start: '2026-10-05', period_end: '2026-10-11', hh_job_number: 16800 }] });
    const p = await getShopPeriodForSale(new Date('2026-10-06T10:00:00Z'), new Date('2026-10-06T10:02:00Z'));
    expect(p.hhJobNumber).toBe(16800);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
