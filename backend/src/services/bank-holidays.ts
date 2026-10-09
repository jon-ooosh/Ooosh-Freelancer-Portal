/**
 * England & Wales bank holidays — COMPUTED, not stored.
 *
 * WHY THIS EXISTS. Migration 216 seeded the dates for 2026–2028, which raised
 * the obvious question: what happens in 2029, and who remembers to add it?
 * The answer is that nobody does, and the calendar quietly stops marking them.
 *
 * They do not need remembering. Seven of the eight are pure arithmetic — two
 * fixed dates, three "nth Monday of a month", and Easter — and the weekend
 * substitution rule is mechanical. So they are derived on demand for any year,
 * and the `staff.bank_holidays.<year>` setting becomes an OVERRIDE for the rare
 * year this gets wrong rather than the only source.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: one-off royal bank holidays — a
 * coronation, a jubilee, a state funeral — are announced by the government and
 * are not computable from anything. They are not a bank-holiday-calendar
 * problem; they are "the company is shut that day", which is what company days
 * (spec §20) are for.
 *
 * Scotland and Northern Ireland differ (2 January, 12 July, St Andrew's Day).
 * Ooosh is in Brighton; if that ever changes this is the one file to edit.
 */

/** YYYY-MM-DD for a UTC y/m/d, with no Date-to-local-midnight drift. */
function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Day of week for a UTC date, Monday = 0 … Sunday = 6. */
function weekday(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Easter Sunday, Gregorian — the anonymous computus.
 *
 * Exported so a test can pin it against known dates; getting Easter wrong
 * moves two bank holidays and nothing else would catch it.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** The nth (1-based) given weekday of a month; `last` counts back from the end. */
function nthWeekday(year: number, month: number, targetWeekday: number, which: number | 'last'): string {
  if (which === 'last') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = lastDay; d >= 1; d--) {
      if (weekday(year, month, d) === targetWeekday) return ymd(year, month, d);
    }
  } else {
    let seen = 0;
    for (let d = 1; d <= 31; d++) {
      if (new Date(Date.UTC(year, month - 1, d)).getUTCMonth() !== month - 1) break;
      if (weekday(year, month, d) === targetWeekday && ++seen === which) return ymd(year, month, d);
    }
  }
  throw new Error(`No such weekday in ${year}-${month}`);
}

export interface BankHoliday {
  date: string;
  name: string;
  /** True when it moved because the real date fell on a weekend. */
  substitute: boolean;
}

/**
 * The eight England & Wales bank holidays for a year, in date order.
 *
 * SUBSTITUTION: a holiday falling on a Saturday or Sunday moves to the next
 * weekday that is not already taken. Christmas and Boxing Day both land on the
 * weekend roughly every six years — 2027 is one — so the "not already taken"
 * part is load-bearing rather than defensive: without it both would substitute
 * onto the same Monday.
 */
export function computeBankHolidays(year: number): BankHoliday[] {
  const easter = easterSunday(year);
  const taken = new Set<string>();

  // The fixed ones substitute; the Monday ones never need to, and Good Friday
  // is a Friday by construction.
  const fixed: { name: string; date: string }[] = [
    { name: "New Year's Day", date: ymd(year, 1, 1) },
    { name: 'Christmas Day', date: ymd(year, 12, 25) },
    { name: 'Boxing Day', date: ymd(year, 12, 26) },
  ];
  const anchored: { name: string; date: string }[] = [
    { name: 'Good Friday', date: addDays(easter, -2) },
    { name: 'Easter Monday', date: addDays(easter, 1) },
    { name: 'Early May bank holiday', date: nthWeekday(year, 5, 0, 1) },
    { name: 'Spring bank holiday', date: nthWeekday(year, 5, 0, 'last') },
    { name: 'Summer bank holiday', date: nthWeekday(year, 8, 0, 'last') },
  ];

  const out: BankHoliday[] = [];
  for (const h of anchored) { taken.add(h.date); out.push({ ...h, substitute: false }); }

  // Christmas before Boxing Day, so 26 December substitutes AROUND the 25th
  // rather than onto it.
  for (const h of fixed.sort((a, b) => a.date.localeCompare(b.date))) {
    let d = h.date;
    const [y, m, dd] = d.split('-').map(Number);
    let wd = weekday(y, m, dd);
    while (wd >= 5 || taken.has(d)) {
      d = addDays(d, 1);
      const [y2, m2, d2] = d.split('-').map(Number);
      wd = weekday(y2, m2, d2);
    }
    taken.add(d);
    out.push({ date: d, name: h.name, substitute: d !== h.date });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Just the dates, which is what the calendar and My Time want. */
export function computeBankHolidayDates(year: number): string[] {
  return computeBankHolidays(year).map(h => h.date);
}
