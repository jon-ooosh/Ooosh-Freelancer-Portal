/**
 * The recurrence engine for repeating to-dos — docs/TASKS-SPEC.md §6.
 *
 * PURE: no database, no clock of its own (callers pass "today"). Everything
 * about "when is the next one" lives here, once, with its own tests — the
 * series service, the preview endpoint and the bells all call it rather than
 * doing date arithmetic of their own.
 *
 * The rule is Google Calendar's custom recurrence, trimmed to what a to-do
 * needs (jon, Sep 2026):
 *   every N day / week / month / year
 *   weekly  → on which weekdays
 *   monthly → on day N, or on the Nth (1st–4th, or last) weekday
 * No iCal library: this subset is small, and a library would bring the whole
 * RRULE language, most of which nobody here would use.
 *
 * TWO MODES (spec §6.2):
 *   schedule   — dates come from the calendar ("every Thursday")
 *   after_done — the next is N after the last one was actually done (bins:
 *                monthly, but calling them in early resets the next visit)
 *
 * Dates are YYYY-MM-DD strings and all arithmetic is in UTC, so a clock
 * change can never shift a date by a day.
 *
 * WEEKDAYS ARE 0 = MONDAY … 6 = SUNDAY, matching the M T W T F S S row the
 * form shows. JavaScript's getUTCDay() is Sunday = 0; `weekday()` converts.
 */

export type Freq = 'day' | 'week' | 'month' | 'year';
export type Mode = 'schedule' | 'after_done';

export type MonthlyRule =
  | { type: 'day'; day: number }                          // 1–31, clamped to the month's end
  | { type: 'nth'; n: 1 | 2 | 3 | 4 | -1; weekday: number };  // -1 = last

export interface RecurrenceRule {
  freq: Freq;
  interval: number;          // ≥ 1
  weekdays?: number[];       // week only; 0 = Mon … 6 = Sun
  monthly?: MonthlyRule;     // month only
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const NTH = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' } as Record<number, string>;
const UNIT = { day: 'day', week: 'week', month: 'month', year: 'year' } as const;
/** The longest a search may walk before giving up — a safety stop, not a rule. */
const MAX_SEARCH_DAYS = 366 * 12;

// ── Date helpers (UTC, YYYY-MM-DD) ──────────────────────────────────────────

function parse(ymd: string): Date {
  if (!DATE_RE.test(ymd)) throw new Error(`Not a date: ${ymd}`);
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${ymd}`);
  return d;
}
function fmt(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(ymd: string, n: number): string {
  const d = parse(ymd); d.setUTCDate(d.getUTCDate() + n); return fmt(d);
}
function lastDayOfMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}
/** 0 = Monday … 6 = Sunday. */
export function weekday(ymd: string): number { return (parse(ymd).getUTCDay() + 6) % 7; }
function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}
function mondayOf(ymd: string): string { return addDays(ymd, -weekday(ymd)); }
function monthsBetween(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
}
/** Add calendar months, clamping to the month's end (31 Jan + 1 → 28/29 Feb). */
function addMonths(ymd: string, n: number): string {
  const d = parse(ymd);
  const day = d.getUTCDate();
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  target.setUTCDate(Math.min(day, lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return fmt(target);
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Normalise and check a rule from the outside world. Throws a message fit to
 * show a human. Fills the defaults the form implies: a weekly rule with no
 * weekdays repeats on the start date's weekday; a monthly one on its day.
 */
export function validateRule(raw: unknown, startsOn: string): RecurrenceRule {
  if (!raw || typeof raw !== 'object') throw new Error('Say how often it repeats');
  const r = raw as Record<string, unknown>;
  const freq = r.freq as Freq;
  if (!['day', 'week', 'month', 'year'].includes(freq)) throw new Error('Repeat every day, week, month or year');
  const interval = Number(r.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) throw new Error('Repeat every 1–99');
  parse(startsOn);

  const rule: RecurrenceRule = { freq, interval };
  if (freq === 'week') {
    const days = Array.isArray(r.weekdays) ? r.weekdays.map(Number) : [];
    const clean = [...new Set(days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    rule.weekdays = clean.length ? clean : [weekday(startsOn)];
  }
  if (freq === 'month') {
    const m = (r.monthly ?? null) as Record<string, unknown> | null;
    if (m && m.type === 'nth') {
      const n = Number(m.n), wd = Number(m.weekday);
      if (![1, 2, 3, 4, -1].includes(n)) throw new Error('Pick first, second, third, fourth or last');
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error('Pick a weekday');
      rule.monthly = { type: 'nth', n: n as 1 | 2 | 3 | 4 | -1, weekday: wd };
    } else {
      const day = Number(m?.day ?? parse(startsOn).getUTCDate());
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Pick a day of the month, 1–31');
      rule.monthly = { type: 'day', day };
    }
  }
  return rule;
}

// ── Matching ────────────────────────────────────────────────────────────────

/** Does `d` fall on the schedule that started at `anchor`? */
export function matches(rule: RecurrenceRule, anchor: string, d: string): boolean {
  if (d < anchor) return false;
  const dd = parse(d);
  switch (rule.freq) {
    case 'day':
      return daysBetween(anchor, d) % rule.interval === 0;
    case 'week': {
      const days = rule.weekdays?.length ? rule.weekdays : [weekday(anchor)];
      if (!days.includes(weekday(d))) return false;
      const weeks = daysBetween(mondayOf(anchor), mondayOf(d)) / 7;
      return weeks % rule.interval === 0;
    }
    case 'month': {
      if (monthsBetween(anchor, d) % rule.interval !== 0) return false;
      const y = dd.getUTCFullYear(), m0 = dd.getUTCMonth(), day = dd.getUTCDate();
      const last = lastDayOfMonth(y, m0);
      const m = rule.monthly ?? { type: 'day', day: parse(anchor).getUTCDate() };
      if (m.type === 'day') return day === Math.min(m.day, last);
      if (weekday(d) !== m.weekday) return false;
      return m.n === -1 ? day + 7 > last : Math.ceil(day / 7) === m.n;
    }
    case 'year': {
      const a = parse(anchor);
      if ((dd.getUTCFullYear() - a.getUTCFullYear()) % rule.interval !== 0) return false;
      if (dd.getUTCMonth() !== a.getUTCMonth()) return false;
      return dd.getUTCDate() === Math.min(a.getUTCDate(), lastDayOfMonth(dd.getUTCFullYear(), dd.getUTCMonth()));
    }
  }
}

/** The first scheduled date on or after `from`. Null only if nothing within the safety stop. */
export function firstOnOrAfter(rule: RecurrenceRule, anchor: string, from: string): string | null {
  let d = from < anchor ? anchor : from;
  for (let i = 0; i <= MAX_SEARCH_DAYS; i++) {
    if (matches(rule, anchor, d)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/**
 * The next occurrence once one is closed (spec §6.3).
 *   schedule   → the next scheduled date after BOTH today and the closed one's
 *                due date: a missed Thursday doesn't breed a backlog, and
 *                ticking Thursday's early on Wednesday doesn't re-create it.
 *   after_done → the day it was actually done, plus the interval. Moving the
 *                open one's date by hand therefore moves everything after it.
 */
export function nextAfterClose(
  mode: Mode, rule: RecurrenceRule, anchor: string,
  opts: { today: string; closedDue: string | null },
): string | null {
  if (mode === 'after_done') return addInterval(rule, opts.today);
  const after = opts.closedDue && opts.closedDue > opts.today ? opts.closedDue : opts.today;
  return firstOnOrAfter(rule, anchor, addDays(after, 1));
}

/** Plain "N units later" — the after_done step. Months and years clamp to the month's end. */
export function addInterval(rule: RecurrenceRule, from: string): string {
  switch (rule.freq) {
    case 'day': return addDays(from, rule.interval);
    case 'week': return addDays(from, rule.interval * 7);
    case 'month': return addMonths(from, rule.interval);
    case 'year': return addMonths(from, rule.interval * 12);
  }
}

/** The next few dates, for the form's preview. */
export function preview(mode: Mode, rule: RecurrenceRule, startsOn: string, count = 3): string[] {
  const out: string[] = [];
  let d = mode === 'schedule' ? firstOnOrAfter(rule, startsOn, startsOn) : startsOn;
  while (d && out.length < count) {
    out.push(d);
    d = mode === 'schedule' ? firstOnOrAfter(rule, startsOn, addDays(d, 1)) : addInterval(rule, d);
  }
  return out;
}

// ── Words ───────────────────────────────────────────────────────────────────

function every(rule: RecurrenceRule): string {
  return rule.interval === 1 ? `Every ${UNIT[rule.freq]}` : `Every ${rule.interval} ${UNIT[rule.freq]}s`;
}

/** "Every week on Thu", "Every month on the first Tuesday", "1 month after the last one". */
export function describe(mode: Mode, rule: RecurrenceRule, anchor: string): string {
  if (mode === 'after_done') {
    const n = rule.interval;
    return `${n} ${UNIT[rule.freq]}${n === 1 ? '' : 's'} after the last one is done`;
  }
  switch (rule.freq) {
    case 'day': return every(rule);
    case 'week': {
      const days = (rule.weekdays?.length ? rule.weekdays : [weekday(anchor)]).map(d => WEEKDAY_SHORT[d]);
      return `${every(rule)} on ${days.join(', ')}`;
    }
    case 'month': {
      const m = rule.monthly ?? { type: 'day', day: parse(anchor).getUTCDate() };
      return m.type === 'day'
        ? `${every(rule)} on day ${m.day}`
        : `${every(rule)} on the ${NTH[m.n]} ${WEEKDAY_LONG[m.weekday]}`;
    }
    case 'year': {
      const a = parse(anchor);
      const when = a.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      return `${every(rule)} on ${when}`;
    }
  }
}
