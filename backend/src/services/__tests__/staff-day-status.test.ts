import {
  daysBetween, addDaysYmd, weekdayIndex, mondayOf, cycleWeekFor,
  dateRange, shiftMinutes, formatMinutes,
  resolveScheduledDay, maskForViewer,
  type StaffDay,
} from '../staff-day-status';

// ── Date maths ──────────────────────────────────────────────────────────────

describe('addDaysYmd / daysBetween', () => {
  it('is UTC-anchored across the BST boundary', () => {
    // Local-Date + toISOString() drifts a day under BST; this must not.
    expect(addDaysYmd('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDaysYmd('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDaysYmd('2026-10-24', 2)).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });
  it('crosses month and year ends', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is
  });
  it('goes backwards', () => {
    expect(addDaysYmd('2027-01-01', -1)).toBe('2026-12-31');
    expect(daysBetween('2027-01-01', '2026-12-31')).toBe(-1);
  });
});

describe('weekdayIndex', () => {
  it('is Monday-first, not JS Sunday-first', () => {
    expect(weekdayIndex('2026-09-07')).toBe(0); // Monday
    expect(weekdayIndex('2026-09-08')).toBe(1);
    expect(weekdayIndex('2026-09-11')).toBe(4); // Friday
    expect(weekdayIndex('2026-09-12')).toBe(5); // Saturday
    expect(weekdayIndex('2026-09-13')).toBe(6); // Sunday — 6, never 0
  });
});

describe('mondayOf', () => {
  it('returns the date itself on a Monday', () => {
    expect(mondayOf('2026-09-07')).toBe('2026-09-07');
  });
  it('walks back from a Sunday to the Monday SIX days earlier, not the next day', () => {
    expect(mondayOf('2026-09-13')).toBe('2026-09-07');
  });
});

describe('cycleWeekFor', () => {
  it('is always week 1 for a single-week pattern', () => {
    expect(cycleWeekFor('2026-09-07', '2026-01-05', 1)).toBe(1);
    expect(cycleWeekFor('2027-06-30', '2026-01-05', 1)).toBe(1);
  });
  it('alternates from the week containing effective_from', () => {
    const from = '2026-09-07'; // Monday
    expect(cycleWeekFor('2026-09-07', from, 2)).toBe(1);
    expect(cycleWeekFor('2026-09-13', from, 2)).toBe(1); // still week 1 (Sunday)
    expect(cycleWeekFor('2026-09-14', from, 2)).toBe(2);
    expect(cycleWeekFor('2026-09-21', from, 2)).toBe(1);
  });
  it('anchors on the MONDAY of the start week, so a mid-week start does not shift the rota', () => {
    // Starting Wednesday 9 Sep must give the same parity as starting Mon 7 Sep.
    expect(cycleWeekFor('2026-09-14', '2026-09-09', 2)).toBe(2);
    expect(cycleWeekFor('2026-09-21', '2026-09-09', 2)).toBe(1);
  });
  it('does not go negative for a date before the anchor', () => {
    expect(cycleWeekFor('2026-08-31', '2026-09-07', 2)).toBe(2);
    expect(cycleWeekFor('2026-08-24', '2026-09-07', 2)).toBe(1);
  });
});

describe('dateRange', () => {
  it('is inclusive of both ends', () => {
    expect(dateRange('2026-09-07', '2026-09-09')).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
  });
  it('returns a single day when from === to', () => {
    expect(dateRange('2026-09-07', '2026-09-07')).toEqual(['2026-09-07']);
  });
  it('spans a month end', () => {
    expect(dateRange('2026-10-30', '2026-11-02')).toHaveLength(4);
  });
});

// ── Minutes: Will Parish's real pattern (spec §0.1) ─────────────────────────

describe('shiftMinutes — the real Ooosh patterns', () => {
  it('computes Will Parish\'s four unequal days', () => {
    expect(shiftMinutes('08:30', '16:30', 30)).toBe(450); // Mon 7h30
    expect(shiftMinutes('08:30', '16:30', 30)).toBe(450); // Tue 7h30
    expect(shiftMinutes('09:15', '19:00', 30)).toBe(555); // Wed 9h15
    expect(shiftMinutes('08:00', '19:00', 30)).toBe(630); // Fri 10h30
  });
  it('totals 2,085 minutes — 34h45m, NOT the assumed 35h', () => {
    const week = 450 + 450 + 555 + 630;
    expect(week).toBe(2085);
    expect(week).toBeLessThan(35 * 60);
    expect(35 * 60 - week).toBe(15); // the 15-minute shortfall, spec §17.5
  });
  it('computes a standard 9-5 day with an hour for lunch', () => {
    expect(shiftMinutes('09:00', '17:00', 60)).toBe(420); // 7h paid
  });
  it('accepts HH:MM:SS as Postgres TIME renders it', () => {
    expect(shiftMinutes('08:30:00', '16:30:00', 30)).toBe(450);
  });
});

describe('formatMinutes', () => {
  it('formats the real day lengths', () => {
    expect(formatMinutes(450)).toBe('7h 30m');
    expect(formatMinutes(630)).toBe('10h 30m');
    expect(formatMinutes(420)).toBe('7h');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(0)).toBe('0m');
  });
  it('handles a negative balance (allowed with a warning, spec §6.2)', () => {
    expect(formatMinutes(-90)).toBe('-1h 30m');
  });
});

// ── The resolver ────────────────────────────────────────────────────────────

const WILL_PATTERN = {
  id: 'pat-1',
  person_id: 'will',
  effective_from: '2026-01-01',
  effective_to: null,
  cycle_weeks: 1,
};

// Mon/Tue 08:30-16:30, Wed 09:15-19:00, Thu off, Fri 08:00-19:00, weekend off.
const WILL_DAYS = [
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 0, is_working: true,  start_time: '08:30', end_time: '16:30', minutes: 450 },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 1, is_working: true,  start_time: '08:30', end_time: '16:30', minutes: 450 },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 2, is_working: true,  start_time: '09:15', end_time: '19:00', minutes: 555 },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 3, is_working: false, start_time: null,    end_time: null,    minutes: 0   },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 4, is_working: true,  start_time: '08:00', end_time: '19:00', minutes: 630 },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 5, is_working: false, start_time: null,    end_time: null,    minutes: 0   },
  { pattern_id: 'pat-1', cycle_week: 1, weekday: 6, is_working: false, start_time: null,    end_time: null,    minutes: 0   },
];
const WILL_MAP = new Map([['pat-1', WILL_DAYS]]);

describe('resolveScheduledDay', () => {
  it('charges each weekday its ACTUAL minutes, not an average', () => {
    // The whole reason for the minutes model — spec §0.1.
    expect(resolveScheduledDay('2026-09-07', [WILL_PATTERN], WILL_MAP, undefined).scheduledMinutes).toBe(450); // Mon
    expect(resolveScheduledDay('2026-09-09', [WILL_PATTERN], WILL_MAP, undefined).scheduledMinutes).toBe(555); // Wed
    expect(resolveScheduledDay('2026-09-11', [WILL_PATTERN], WILL_MAP, undefined).scheduledMinutes).toBe(630); // Fri
    // A Friday off costs 180 minutes more than a Monday off. Deliberate.
    expect(630 - 450).toBe(180);
  });
  it('marks his Thursday not_scheduled with zero minutes', () => {
    const d = resolveScheduledDay('2026-09-10', [WILL_PATTERN], WILL_MAP, undefined);
    expect(d.status).toBe('not_scheduled');
    expect(d.scheduledMinutes).toBe(0);
    expect(d.startTime).toBeNull();
  });
  it('marks the weekend not_scheduled', () => {
    expect(resolveScheduledDay('2026-09-12', [WILL_PATTERN], WILL_MAP, undefined).status).toBe('not_scheduled');
    expect(resolveScheduledDay('2026-09-13', [WILL_PATTERN], WILL_MAP, undefined).status).toBe('not_scheduled');
  });
  it('returns not_scheduled before the pattern starts and after it ends', () => {
    const closed = { ...WILL_PATTERN, effective_to: '2026-06-30' };
    expect(resolveScheduledDay('2025-12-31', [WILL_PATTERN], WILL_MAP, undefined).status).toBe('not_scheduled');
    expect(resolveScheduledDay('2026-07-01', [closed], WILL_MAP, undefined).status).toBe('not_scheduled');
    expect(resolveScheduledDay('2026-06-30', [closed], WILL_MAP, undefined).status).toBe('working');
  });

  it('picks the pattern in force on the date, so history does not retroactively change', () => {
    // He moves to a plain Mon-only pattern from July. September must use the
    // NEW pattern; June must still use the old one (spec §0.3).
    const old = { ...WILL_PATTERN, effective_to: '2026-06-30' };
    const neu = { id: 'pat-2', person_id: 'will', effective_from: '2026-07-01', effective_to: null, cycle_weeks: 1 };
    const map = new Map([
      ['pat-1', WILL_DAYS],
      ['pat-2', [{ pattern_id: 'pat-2', cycle_week: 1, weekday: 0, is_working: true, start_time: '09:00', end_time: '17:00', minutes: 420 }]],
    ]);
    expect(resolveScheduledDay('2026-06-01', [old, neu], map, undefined).scheduledMinutes).toBe(450);
    expect(resolveScheduledDay('2026-09-07', [old, neu], map, undefined).scheduledMinutes).toBe(420);
    // Wednesday isn't in the new pattern at all.
    expect(resolveScheduledDay('2026-09-09', [old, neu], map, undefined).status).toBe('not_scheduled');
  });

  it('lets an approved exception override the pattern (a swap leg turning a day ON)', () => {
    const d = resolveScheduledDay('2026-09-10', [WILL_PATTERN], WILL_MAP, {
      person_id: 'will', exception_date: '2026-09-10', is_working: true,
      start_time: '09:00', end_time: '17:00', minutes: 420,
    });
    expect(d.status).toBe('working');       // normally his day off
    expect(d.scheduledMinutes).toBe(420);
    expect(d.isException).toBe(true);
  });
  it('lets an approved exception turn a working day OFF (the other swap leg)', () => {
    const d = resolveScheduledDay('2026-09-09', [WILL_PATTERN], WILL_MAP, {
      person_id: 'will', exception_date: '2026-09-09', is_working: false,
      start_time: null, end_time: null, minutes: 0,
    });
    expect(d.status).toBe('not_scheduled');
    expect(d.scheduledMinutes).toBe(0);
    expect(d.isException).toBe(true);
  });
  it('applies an exception even where no pattern covers the date', () => {
    const d = resolveScheduledDay('2025-11-05', [WILL_PATTERN], WILL_MAP, {
      person_id: 'will', exception_date: '2025-11-05', is_working: true,
      start_time: '09:00', end_time: '17:00', minutes: 420,
    });
    expect(d.status).toBe('working');
  });

  it('resolves a 2-week alternating pattern by cycle week', () => {
    const alt = { id: 'p', person_id: 'x', effective_from: '2026-09-07', effective_to: null, cycle_weeks: 2 };
    const map = new Map([['p', [
      { pattern_id: 'p', cycle_week: 1, weekday: 5, is_working: true,  start_time: '09:00', end_time: '17:00', minutes: 480 },
      { pattern_id: 'p', cycle_week: 2, weekday: 5, is_working: false, start_time: null,    end_time: null,    minutes: 0 },
    ]]]);
    expect(resolveScheduledDay('2026-09-12', [alt], map, undefined).status).toBe('working');       // Sat, week 1
    expect(resolveScheduledDay('2026-09-19', [alt], map, undefined).status).toBe('not_scheduled'); // Sat, week 2
    expect(resolveScheduledDay('2026-09-26', [alt], map, undefined).status).toBe('working');       // Sat, week 1 again
  });
});

// ── Masking (spec §0.5) ─────────────────────────────────────────────────────

describe('maskForViewer', () => {
  const days: StaffDay[] = [{
    date: '2026-09-08',
    scheduledMinutes: 450,
    status: 'absent',
    startTime: null,
    endTime: null,
    isException: false,
    detail: { absenceType: 'sickness' },
  }];

  it('strips the absence type for a non-admin viewer', () => {
    const masked = maskForViewer(days, false);
    expect(masked[0].detail).toBeUndefined();
    expect(masked[0].status).toBe('absent'); // they still see that the person is out
  });
  it('keeps the detail for admin', () => {
    expect(maskForViewer(days, true)[0].detail).toEqual({ absenceType: 'sickness' });
  });
  it('does not mutate the input', () => {
    maskForViewer(days, false);
    expect(days[0].detail).toEqual({ absenceType: 'sickness' });
  });
  it('keeps a timed appointment window for peers — the time is operational, the reason is not', () => {
    const appt: StaffDay[] = [{
      date: '2026-09-08', scheduledMinutes: 450, status: 'partial',
      startTime: '09:00', endTime: '17:00', portion: 'hours',
      window: { start: '14:00', end: '15:00' },
      isException: false, detail: { absenceType: 'medical_appointment' },
    }];
    const masked = maskForViewer(appt, false);
    expect(masked[0].window).toEqual({ start: '14:00', end: '15:00' });
    expect(masked[0].detail).toBeUndefined();
  });
});
