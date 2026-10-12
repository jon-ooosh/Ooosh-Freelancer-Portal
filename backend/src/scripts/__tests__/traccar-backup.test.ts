// planTraccarRetention is pure; keep R2 and pg out of it.
jest.mock('../../config/r2', () => ({}));
jest.mock('pg', () => ({ Client: jest.fn() }));

import { planTraccarRetention } from '../traccar-backup';

const day = (iso: string) => ({ key: `backups/traccar/traccar-${iso}.dump`, at: new Date(`${iso}T02:10:00Z`) });

describe('planTraccarRetention', () => {
  it('keeps everything while there are 7 or fewer', () => {
    const dumps = ['2026-10-01', '2026-10-02', '2026-10-03'].map(day);
    expect(planTraccarRetention(dumps)).toEqual([]);
  });

  it('keeps the 7 newest plus the newest of each of the 4 weeks before them', () => {
    // 60 nightly dumps, 14 Aug → 12 Oct 2026.
    const dumps = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 14 + i));
      return day(d.toISOString().slice(0, 10));
    });
    const deleted = new Set(planTraccarRetention(dumps));
    const kept = dumps.filter(d => !deleted.has(d.key)).map(d => d.key.slice(-15, -5)).sort();
    expect(kept).toEqual([
      // the newest (a Sunday) of each of the 4 weeks before the 7 newest
      '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04',
      // the 7 newest, 6–12 Oct (they span two weeks, as 12 Oct is a Monday)
      '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12',
    ]);
    expect(deleted.size).toBe(60 - 11);
  });

  it('does not depend on the order R2 lists them in', () => {
    const dumps = Array.from({ length: 20 }, (_, i) => day(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)));
    const a = planTraccarRetention(dumps).sort();
    const b = planTraccarRetention([...dumps].reverse()).sort();
    expect(a).toEqual(b);
  });
});
