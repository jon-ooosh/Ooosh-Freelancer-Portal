/**
 * The recurrence engine — "when is the next one?" — for repeating to-dos
 * (docs/TASKS-SPEC.md §6). Pure functions, so every case jon described is
 * pinned here with real calendar dates.
 *
 * 2026-10-01 is a Thursday. Weekdays are 0 = Monday … 6 = Sunday.
 */
import {
  validateRule, matches, firstOnOrAfter, nextAfterClose, addInterval,
  preview, describe as describeRule, weekday, RecurrenceRule,
} from '../task-recurrence';

const THU = '2026-10-01';

describe('weekday numbering', () => {
  it('is Monday = 0 … Sunday = 6', () => {
    expect(weekday('2026-09-28')).toBe(0); // Mon
    expect(weekday(THU)).toBe(3);
    expect(weekday('2026-10-04')).toBe(6); // Sun
  });
});

describe('validateRule', () => {
  it('defaults a weekly rule to the start date’s weekday', () => {
    expect(validateRule({ freq: 'week', interval: 1 }, THU).weekdays).toEqual([3]);
  });
  it('defaults a monthly rule to the start date’s day', () => {
    expect(validateRule({ freq: 'month' }, '2026-10-15').monthly).toEqual({ type: 'day', day: 15 });
  });
  it('refuses nonsense with a human message', () => {
    expect(() => validateRule({ freq: 'fortnight' }, THU)).toThrow(/day, week, month or year/);
    expect(() => validateRule({ freq: 'day', interval: 0 }, THU)).toThrow(/1–99/);
    expect(() => validateRule({ freq: 'month', monthly: { type: 'nth', n: 5, weekday: 1 } }, THU))
      .toThrow(/first, second/);
  });
  it('drops duplicate and out-of-range weekdays', () => {
    expect(validateRule({ freq: 'week', weekdays: [3, 3, 9, 0] }, THU).weekdays).toEqual([0, 3]);
  });
});

describe('schedule mode', () => {
  it('reads the meters every Thursday', () => {
    const rule: RecurrenceRule = { freq: 'week', interval: 1, weekdays: [3] };
    expect(preview('schedule', rule, THU)).toEqual(['2026-10-01', '2026-10-08', '2026-10-15']);
  });

  it('starts on the first matching day when the start date isn’t one', () => {
    const rule: RecurrenceRule = { freq: 'week', interval: 1, weekdays: [3] };
    expect(firstOnOrAfter(rule, '2026-09-29', '2026-09-29')).toBe('2026-10-01');
  });

  it('every 2 weeks on Mon and Thu counts weeks from the start week', () => {
    const rule: RecurrenceRule = { freq: 'week', interval: 2, weekdays: [0, 3] };
    expect(preview('schedule', rule, '2026-09-28', 4))
      .toEqual(['2026-09-28', '2026-10-01', '2026-10-12', '2026-10-15']);
  });

  it('first Tuesday of the month', () => {
    const rule: RecurrenceRule = { freq: 'month', interval: 1, monthly: { type: 'nth', n: 1, weekday: 1 } };
    expect(preview('schedule', rule, '2026-10-01', 3)).toEqual(['2026-10-06', '2026-11-03', '2026-12-01']);
  });

  it('last Friday of the month', () => {
    const rule: RecurrenceRule = { freq: 'month', interval: 1, monthly: { type: 'nth', n: -1, weekday: 4 } };
    expect(preview('schedule', rule, '2026-10-01', 3)).toEqual(['2026-10-30', '2026-11-27', '2026-12-25']);
  });

  it('day 31 lands on the last day of shorter months rather than skipping them', () => {
    const rule: RecurrenceRule = { freq: 'month', interval: 1, monthly: { type: 'day', day: 31 } };
    expect(preview('schedule', rule, '2027-01-31', 3)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('every 3 months', () => {
    const rule: RecurrenceRule = { freq: 'month', interval: 3, monthly: { type: 'day', day: 5 } };
    expect(preview('schedule', rule, '2026-10-05', 3)).toEqual(['2026-10-05', '2027-01-05', '2027-04-05']);
  });

  it('every year, 29 Feb falling back to 28 Feb', () => {
    const rule: RecurrenceRule = { freq: 'year', interval: 1 };
    expect(preview('schedule', rule, '2028-02-29', 2)).toEqual(['2028-02-29', '2029-02-28']);
  });

  it('every 3 days', () => {
    expect(preview('schedule', { freq: 'day', interval: 3 }, THU)).toEqual(['2026-10-01', '2026-10-04', '2026-10-07']);
  });
});

describe('the next one, once one is closed (spec §6.3)', () => {
  const weekly: RecurrenceRule = { freq: 'week', interval: 1, weekdays: [3] };

  it('a missed Thursday does not breed a backlog — next is after TODAY', () => {
    // Due 1 Oct, ticked three weeks late on 22 Oct (a Thursday): next is 29 Oct.
    expect(nextAfterClose('schedule', weekly, THU, { today: '2026-10-22', closedDue: THU }))
      .toBe('2026-10-29');
  });

  it('ticking Thursday’s early on Wednesday doesn’t re-create Thursday’s', () => {
    expect(nextAfterClose('schedule', weekly, THU, { today: '2026-09-30', closedDue: THU }))
      .toBe('2026-10-08');
  });

  it('bins: after_done counts from the day it actually happened', () => {
    const monthly: RecurrenceRule = { freq: 'month', interval: 1, monthly: { type: 'day', day: 1 } };
    // Called in early and collected on 20 Oct → next is 20 Nov, not 1 Nov.
    expect(nextAfterClose('after_done', monthly, THU, { today: '2026-10-20', closedDue: '2026-11-01' }))
      .toBe('2026-11-20');
  });

  it('after_done in weeks and days', () => {
    expect(addInterval({ freq: 'week', interval: 2 }, THU)).toBe('2026-10-15');
    expect(addInterval({ freq: 'day', interval: 10 }, THU)).toBe('2026-10-11');
  });
});

describe('matches', () => {
  it('never matches before the start', () => {
    expect(matches({ freq: 'day', interval: 1 }, THU, '2026-09-30')).toBe(false);
  });
});

describe('describeRule', () => {
  it('says it the way a person would', () => {
    expect(describeRule('schedule', { freq: 'week', interval: 1, weekdays: [3] }, THU)).toBe('Every week on Thu');
    expect(describeRule('schedule', { freq: 'week', interval: 2, weekdays: [0, 3] }, THU)).toBe('Every 2 weeks on Mon, Thu');
    expect(describeRule('schedule', { freq: 'month', interval: 1, monthly: { type: 'nth', n: 1, weekday: 1 } }, THU))
      .toBe('Every month on the first Tuesday');
    expect(describeRule('schedule', { freq: 'month', interval: 1, monthly: { type: 'nth', n: -1, weekday: 4 } }, THU))
      .toBe('Every month on the last Friday');
    expect(describeRule('schedule', { freq: 'month', interval: 1, monthly: { type: 'day', day: 15 } }, THU))
      .toBe('Every month on day 15');
    expect(describeRule('after_done', { freq: 'month', interval: 1 }, THU)).toBe('1 month after the last one is done');
    expect(describeRule('schedule', { freq: 'year', interval: 1 }, '2026-03-05')).toBe('Every year on 5 Mar');
  });
});
