import {
  overlapDays, daysInYear, roundUpToHalfDay, computeEntitlement, STATUTORY_WEEKS,
} from '../staff-balance';

// The two real Ooosh weeks (spec §0.1).
const STANDARD_WEEK = 2100; // Mon-Fri 9-5 less an hour for lunch = 7h paid × 5
const WILL_WEEK = 2085;     // 450 + 450 + 555 + 630, four unequal days
const STANDARD_DAY = 420;
const WILL_DAY = 521.25;    // 2085 / 4 — a length he never actually works

describe('overlapDays', () => {
  it('counts inclusively', () => {
    expect(overlapDays('2027-01-01', '2027-01-31', '2027-01-01', '2027-12-31')).toBe(31);
    expect(overlapDays('2027-03-05', '2027-03-05', '2027-01-01', '2027-12-31')).toBe(1);
  });
  it('returns 0 for disjoint ranges', () => {
    expect(overlapDays('2027-01-01', '2027-01-31', '2027-02-01', '2027-12-31')).toBe(0);
  });
  it('clips to the tighter range at both ends', () => {
    expect(overlapDays('2026-06-01', '2028-06-01', '2027-01-01', '2027-12-31')).toBe(365);
  });
});

describe('daysInYear', () => {
  it('knows its leap years', () => {
    expect(daysInYear(2027)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365); // divisible by 100, not by 400
    expect(daysInYear(2000)).toBe(366);
  });
});

describe('roundUpToHalfDay', () => {
  it('rounds UP, never down — rounding down can breach the statutory minimum', () => {
    expect(roundUpToHalfDay(421, STANDARD_DAY)).toBe(630);   // 1 day + 1 min → 1.5 days
    expect(roundUpToHalfDay(419, STANDARD_DAY)).toBe(420);   // just under a day → 1 day
  });
  it('leaves an exact half-day alone', () => {
    expect(roundUpToHalfDay(420, STANDARD_DAY)).toBe(420);
    expect(roundUpToHalfDay(210, STANDARD_DAY)).toBe(210);
    expect(roundUpToHalfDay(2100, STANDARD_DAY)).toBe(2100);
  });
  it('does not creep upward on a value that is already exact (float guard)', () => {
    // 5.6 × 2100 = 11760 = exactly 28 days of 420. Naive ceil() on a float can
    // tip this to 28.5 days and quietly gift half a day a year, every year.
    expect(roundUpToHalfDay(STATUTORY_WEEKS * STANDARD_WEEK, STANDARD_DAY)).toBe(11760);
  });
  it('rounds an unequal-day person up to a whole half of THEIR day', () => {
    // Will's half-day is 260.625 min. A pro-rated figure lands wherever it
    // lands; rounding must reach the next half-day of his, not of a notional
    // 8-hour one.
    const half = WILL_DAY / 2;
    const prorated = STATUTORY_WEEKS * WILL_WEEK * (184 / 365); // joined 1 July
    const rounded = roundUpToHalfDay(prorated, WILL_DAY);
    expect(rounded).toBeGreaterThanOrEqual(prorated);
    expect(rounded - prorated).toBeLessThan(half);
    expect(rounded % half).toBeCloseTo(0, 6);
  });

  it('is NOT applied to a full year — that figure is already exact', () => {
    // 5.6 weeks of Will's week is 22.4 of his days, which is not a whole
    // number of half-days. Rounding it would gift him an extra ~52 minutes
    // every year and contradict the 194.6h the spec quotes.
    const full = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: [{ effectiveFrom: '2020-01-01', effectiveTo: null, weeklyMinutes: WILL_WEEK }],
      nominalDayMinutes: WILL_DAY,
    });
    expect(full.isPartYear).toBe(false);
    expect(full.totalMinutes).toBe(11676);
    expect(full.totalMinutes).toBeLessThan(roundUpToHalfDay(11676, WILL_DAY));
  });
  it('falls back to a whole minute when there is no nominal day', () => {
    expect(roundUpToHalfDay(1234.2, 0)).toBe(1235);
  });
});

describe('computeEntitlement', () => {
  const fullYear = (weeklyMinutes: number) => ([{
    effectiveFrom: '2020-01-01', effectiveTo: null, weeklyMinutes,
  }]);

  it('gives a full-year standard employee 5.6 weeks exactly — 196h / 28 days', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.totalMinutes).toBe(11760);
    expect(r.totalMinutes / 60).toBe(196);
    expect(r.totalMinutes / STANDARD_DAY).toBe(28);
  });

  it('gives Will 194.6h — the same 5.6 weeks, but 22.4 of HIS days', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: fullYear(WILL_WEEK), nominalDayMinutes: WILL_DAY,
    });
    expect(r.totalMinutes / 60).toBeCloseTo(194.6, 1);
    expect(r.totalMinutes / WILL_DAY).toBeCloseTo(22.4, 1);
    // Fewer days than the standard employee, but only 84 minutes fewer hours.
    expect(11760 - r.totalMinutes).toBeCloseTo(84, 0);
  });

  it('pro-rates a mid-year starter by the share of the year they are employed', () => {
    // Joins 1 July 2027 — 184 of 365 days.
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2027-07-01', employedTo: null,
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.segments[0].days).toBe(184);
    expect(r.rawMinutes).toBeCloseTo(11760 * (184 / 365), 0);
    // Rounded UP to a half day, so never short.
    expect(r.totalMinutes).toBeGreaterThanOrEqual(r.rawMinutes);
    expect(r.totalMinutes % (STANDARD_DAY / 2)).toBeCloseTo(0, 6);
  });

  it('pro-rates a leaver the same way', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: '2027-03-31',
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.segments[0].days).toBe(90); // Jan 31 + Feb 28 + Mar 31
    expect(r.rawMinutes).toBeCloseTo(11760 * (90 / 365), 0);
  });

  it('splits across an hours change mid-year rather than using one figure', () => {
    // Full-time to Sep 30, then a 4-day week. Neither figure alone is right.
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: [
        { effectiveFrom: '2020-01-01', effectiveTo: '2027-09-30', weeklyMinutes: 2100 },
        { effectiveFrom: '2027-10-01', effectiveTo: null, weeklyMinutes: 1680 },
      ],
      nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].days).toBe(273); // Jan 1 – Sep 30
    expect(r.segments[1].days).toBe(92);  // Oct 1 – Dec 31
    expect(r.segments[0].days + r.segments[1].days).toBe(365);

    const expected = 5.6 * 2100 * (273 / 365) + 5.6 * 1680 * (92 / 365);
    expect(r.rawMinutes).toBeCloseTo(expected, 6);
    // Strictly between the two full-year figures — the point of segmenting.
    expect(r.rawMinutes).toBeLessThan(5.6 * 2100);
    expect(r.rawMinutes).toBeGreaterThan(5.6 * 1680);
  });

  it('uses 366 days in a leap year, so a part-year figure is not inflated', () => {
    const leap = computeEntitlement({
      year: 2028, weeks: STATUTORY_WEEKS,
      employedFrom: '2028-07-01', employedTo: null,
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(leap.segments[0].days).toBe(184); // Jul 1 – Dec 31, same as 2027
    expect(leap.rawMinutes).toBeCloseTo(11760 * (184 / 366), 6);
    expect(leap.rawMinutes).toBeLessThan(11760 * (184 / 365));
  });

  it('ignores a pattern that does not touch the year at all', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: [
        { effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31', weeklyMinutes: 2100 },
        { effectiveFrom: '2026-01-01', effectiveTo: null, weeklyMinutes: 1680 },
      ],
      nominalDayMinutes: 420,
    });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].weeklyMinutes).toBe(1680);
  });

  it('returns nothing when there are no working hours to compute from', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2020-01-01', employedTo: null,
      patterns: [], nominalDayMinutes: null,
    });
    expect(r.totalMinutes).toBe(0);
    expect(r.segments).toHaveLength(0);
  });

  it('honours a non-statutory contractual allowance', () => {
    const r = computeEntitlement({
      year: 2027, weeks: 6.6,          // 5.6 statutory + 5 extra days
      employedFrom: '2020-01-01', employedTo: null,
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.totalMinutes / STANDARD_DAY).toBeCloseTo(33, 6);
  });

  it('gives someone who joins on 31 December a token entitlement, not zero', () => {
    const r = computeEntitlement({
      year: 2027, weeks: STATUTORY_WEEKS,
      employedFrom: '2027-12-31', employedTo: null,
      patterns: fullYear(STANDARD_WEEK), nominalDayMinutes: STANDARD_DAY,
    });
    expect(r.segments[0].days).toBe(1);
    expect(r.totalMinutes).toBeGreaterThan(0);      // rounding up protects them
    expect(r.totalMinutes).toBe(STANDARD_DAY / 2);  // half a day
  });
});
