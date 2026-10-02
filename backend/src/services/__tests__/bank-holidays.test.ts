import { computeBankHolidays, computeBankHolidayDates, easterSunday } from '../bank-holidays';

describe('easterSunday', () => {
  // Pinned against published dates. Easter moves two bank holidays, and
  // nothing else in the system would notice if it were wrong.
  it.each([
    [2024, '2024-03-31'], [2025, '2025-04-20'], [2026, '2026-04-05'],
    [2027, '2027-03-28'], [2028, '2028-04-16'], [2029, '2029-04-01'],
    [2030, '2030-04-21'], [2038, '2038-04-25'],
  ])('is right for %i', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('computeBankHolidays', () => {
  it('gives eight every year', () => {
    for (let y = 2024; y <= 2040; y++) {
      expect(computeBankHolidays(y)).toHaveLength(8);
    }
  });

  it('never produces a weekend date', () => {
    for (let y = 2024; y <= 2040; y++) {
      for (const h of computeBankHolidays(y)) {
        const [yy, m, d] = h.date.split('-').map(Number);
        const wd = new Date(Date.UTC(yy, m - 1, d)).getUTCDay();
        expect([0, 6]).not.toContain(wd);
      }
    }
  });

  it('never produces a duplicate date', () => {
    for (let y = 2024; y <= 2040; y++) {
      const dates = computeBankHolidayDates(y);
      expect(new Set(dates).size).toBe(dates.length);
    }
  });

  it('matches the dates migration 216 seeded for 2026', () => {
    expect(computeBankHolidayDates(2026).join()).toBe(
      '2026-01-01,2026-04-03,2026-04-06,2026-05-04,2026-05-25,2026-08-31,2026-12-25,2026-12-28');
  });

  it('matches the dates migration 216 seeded for 2027', () => {
    expect(computeBankHolidayDates(2027).join()).toBe(
      '2027-01-01,2027-03-26,2027-03-29,2027-05-03,2027-05-31,2027-08-30,2027-12-27,2027-12-28');
  });

  it('matches the dates migration 216 seeded for 2028', () => {
    expect(computeBankHolidayDates(2028).join()).toBe(
      '2028-01-03,2028-04-14,2028-04-17,2028-05-01,2028-05-29,2028-08-28,2028-12-25,2028-12-26');
  });

  it('substitutes a Saturday Boxing Day onto the following Monday', () => {
    // 26 Dec 2026 is a Saturday and the 25th is a Friday.
    const bh = computeBankHolidays(2026);
    const boxing = bh.find(h => h.name === 'Boxing Day')!;
    expect(boxing.date).toBe('2026-12-28');
    expect(boxing.substitute).toBe(true);
  });

  it('gives Christmas and Boxing Day SEPARATE days when both fall on a weekend', () => {
    // The case that breaks a naive substitution: 25 Dec 2027 is a Saturday and
    // the 26th a Sunday, so both want the Monday.
    const bh = computeBankHolidays(2027);
    expect(bh.find(h => h.name === 'Christmas Day')!.date).toBe('2027-12-27');
    expect(bh.find(h => h.name === 'Boxing Day')!.date).toBe('2027-12-28');
  });

  it('moves a Saturday New Year onto the Monday', () => {
    // 1 Jan 2028 is a Saturday.
    const ny = computeBankHolidays(2028).find(h => h.name === "New Year's Day")!;
    expect(ny.date).toBe('2028-01-03');
    expect(ny.substitute).toBe(true);
  });

  it('leaves a weekday holiday alone and does not mark it substitute', () => {
    const ny = computeBankHolidays(2026).find(h => h.name === "New Year's Day")!;
    expect(ny.date).toBe('2026-01-01');
    expect(ny.substitute).toBe(false);
  });

  it('puts the spring holiday on the LAST Monday of May, not the fourth', () => {
    // May 2027 has five Mondays; the holiday is the 31st, not the 24th.
    expect(computeBankHolidays(2027).find(h => h.name === 'Spring bank holiday')!.date)
      .toBe('2027-05-31');
  });
});
