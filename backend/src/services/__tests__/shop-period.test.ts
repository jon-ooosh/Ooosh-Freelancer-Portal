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

import { weekStart } from '../shop-period';

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
