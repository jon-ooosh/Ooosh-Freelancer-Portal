/**
 * Staff day status — THE definition of "is this person in on this date?"
 *
 * See docs/STAFF-CALENDAR-SPEC.md §4.2.
 *
 * Three things can answer "in or out": the working pattern (+ one-off
 * exceptions), approved leave, and absence. Three sources means two screens
 * eventually disagree, so exactly ONE resolver merges them and everything —
 * the global calendar, the dashboard strip, coverage warnings, the iCal feed,
 * the approval context panel — calls it. Nothing else queries the underlying
 * tables to answer this question.
 *
 * Phase A implements the pattern + exception layer. Leave (Phase B) and
 * absence (Phase D) merge in at mergeAbsenceLayer() below, which is the single
 * place they attach; no caller changes when they land.
 *
 * MASKING (spec §0.5): sickness and parental data is special-category under UK
 * GDPR. Peers see 'Absent' with no type and no reason. maskForViewer() applies
 * that here, in the service, so a full record cannot reach the browser and get
 * hidden in React instead.
 *
 * DATES: every date in this module is a 'YYYY-MM-DD' string, handled in UTC.
 * Postgres DATE columns are selected as ::text so node-postgres never hands us
 * a JS Date at local midnight (which drifts a day under BST).
 */

import { query } from '../config/database';

// ── Pure date helpers (UTC-anchored; exported for tests) ────────────────────

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Days between two YYYY-MM-DD dates (b - a). UTC, so BST never shifts it. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86400000);
}

/** Add days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
export function addDaysYmd(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Weekday index with MONDAY = 0 … SUNDAY = 6.
 *
 * This is the ONLY place that converts from JS's Sunday-first getUTCDay().
 * The DB stores Monday-first (staff_working_pattern_days.weekday) because the
 * working week starts on Monday everywhere else in this module.
 */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  return addDaysYmd(date, -weekdayIndex(date));
}

/**
 * Which week of the pattern cycle `date` falls in (1-based).
 *
 * Anchored on the Monday of the week containing effective_from, so a 2-week
 * pattern alternates from the week it started — not from an arbitrary epoch,
 * which would flip the whole rota if the start date moved by a day.
 */
export function cycleWeekFor(date: string, effectiveFrom: string, cycleWeeks: number): number {
  if (cycleWeeks <= 1) return 1;
  const weeks = Math.floor(daysBetween(mondayOf(effectiveFrom), mondayOf(date)) / 7);
  // JS % keeps the sign; dates before the anchor must still land in range.
  return (((weeks % cycleWeeks) + cycleWeeks) % cycleWeeks) + 1;
}

/** Enumerate YYYY-MM-DD dates from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** Minutes worked between two HH:MM(:SS) times less an unpaid break. */
export function shiftMinutes(start: string, end: string, breakMinutes: number): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(end) - toMin(start) - breakMinutes;
}

/** Minutes → "7h 30m" / "45m" / "0m", for display only. */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type DayStatus = 'working' | 'not_scheduled' | 'leave' | 'absent' | 'partial';
export type DayPortion = 'full' | 'am' | 'pm' | 'hours';

export interface DayDetail {
  leaveType?: string;
  absenceType?: string;
}

export interface StaffDay {
  date: string;
  /** Contracted minutes for this date, before any leave or absence. */
  scheduledMinutes: number;
  status: DayStatus;
  startTime: string | null;
  endTime: string | null;
  portion?: DayPortion;
  /** Set when portion = 'hours' — a timed appointment window (spec §7.5). */
  window?: { start: string; end: string };
  /** True when a pattern exception (incl. a swap leg) applies to this date. */
  isException: boolean;
  /** ADMIN ONLY. Stripped by maskForViewer() for everyone else. */
  detail?: DayDetail;
}

export interface StaffCalendarPerson {
  personId: string;
  name: string;
  preferredName: string | null;
  jobTitle: string | null;
  department: string | null;
  days: StaffDay[];
}

interface PatternRow {
  id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
  cycle_weeks: number;
}
interface PatternDayRow {
  pattern_id: string;
  cycle_week: number;
  weekday: number;
  is_working: boolean;
  start_time: string | null;
  end_time: string | null;
  minutes: number;
}
interface ExceptionRow {
  person_id: string;
  exception_date: string;
  is_working: boolean;
  start_time: string | null;
  end_time: string | null;
  minutes: number;
}

// ── The resolver (pure — exported for tests) ────────────────────────────────

/**
 * Resolve one person's contracted day from their patterns and exceptions.
 *
 * An approved exception WINS over the pattern for that date — that is the
 * whole point of an exception, and it is how both legs of a swap take effect.
 */
export function resolveScheduledDay(
  date: string,
  patterns: PatternRow[],
  patternDays: Map<string, PatternDayRow[]>,
  exception: ExceptionRow | undefined
): StaffDay {
  if (exception) {
    return {
      date,
      scheduledMinutes: exception.minutes,
      status: exception.is_working ? 'working' : 'not_scheduled',
      startTime: exception.start_time,
      endTime: exception.end_time,
      isException: true,
    };
  }

  // The pattern in force ON this date. Ranges never overlap (enforced on write),
  // so at most one matches.
  const pattern = patterns.find(
    p => p.effective_from <= date && (p.effective_to === null || p.effective_to >= date)
  );
  if (!pattern) {
    // Before they joined, after they left, or a gap between patterns.
    return { date, scheduledMinutes: 0, status: 'not_scheduled', startTime: null, endTime: null, isException: false };
  }

  const week = cycleWeekFor(date, pattern.effective_from, pattern.cycle_weeks);
  const wd = weekdayIndex(date);
  const day = (patternDays.get(pattern.id) ?? []).find(d => d.cycle_week === week && d.weekday === wd);

  if (!day || !day.is_working) {
    return { date, scheduledMinutes: 0, status: 'not_scheduled', startTime: null, endTime: null, isException: false };
  }
  return {
    date,
    scheduledMinutes: day.minutes,
    status: 'working',
    startTime: day.start_time,
    endTime: day.end_time,
    isException: false,
  };
}

/**
 * Overlay leave and absence onto the contracted days.
 *
 * Phase A has neither table, so this is the identity function — but it is the
 * single attachment point for Phase B (leave) and Phase D (absence), so when
 * they land no caller and no other function changes.
 */
export function mergeAbsenceLayer(days: StaffDay[]): StaffDay[] {
  return days;
}

/**
 * Strip special-category detail for anyone who isn't admin (spec §0.5).
 *
 * Peers keep the SHAPE — they can see someone is absent, and for a timed
 * appointment they keep the window, because "out 14:00–15:00" is the
 * operational fact the team needs. They never learn the type or the reason.
 */
export function maskForViewer(days: StaffDay[], isAdmin: boolean): StaffDay[] {
  if (isAdmin) return days;
  return days.map(d => (d.detail ? { ...d, detail: undefined } : d));
}

// ── DB reads ────────────────────────────────────────────────────────────────

/** People with a current employment row — THE definition of "staff" here. */
export async function listStaffPeople(): Promise<
  { person_id: string; name: string; preferred_name: string | null; job_title: string | null; department: string | null }[]
> {
  const r = await query(
    `SELECT se.person_id,
            (p.first_name || ' ' || p.last_name) AS name,
            p.preferred_name,
            se.job_title,
            se.department
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'
        AND p.is_deleted = false
      ORDER BY p.first_name, p.last_name`
  );
  return r.rows;
}

/**
 * The team calendar for a date range.
 *
 * One query per table for the whole range rather than a lookup per person-day
 * (7 staff × 31 days = 217 round trips otherwise), then resolved in memory.
 */
export async function getStaffCalendar(
  from: string,
  to: string,
  opts: { isAdmin: boolean; personId?: string }
): Promise<StaffCalendarPerson[]> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('Dates must be YYYY-MM-DD');
  if (to < from) throw new Error('`to` must be on or after `from`');

  const people = (await listStaffPeople()).filter(p => !opts.personId || p.person_id === opts.personId);
  if (people.length === 0) return [];
  const ids = people.map(p => p.person_id);

  const patternsRes = await query(
    `SELECT id, person_id,
            effective_from::text AS effective_from,
            effective_to::text   AS effective_to,
            cycle_weeks
       FROM staff_working_patterns
      WHERE person_id = ANY($1::uuid[])
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from`,
    [ids, from, to]
  );
  const patterns: PatternRow[] = patternsRes.rows;

  const patternDays = new Map<string, PatternDayRow[]>();
  if (patterns.length > 0) {
    const daysRes = await query(
      `SELECT pattern_id, cycle_week, weekday, is_working,
              start_time::text AS start_time,
              end_time::text   AS end_time,
              minutes
         FROM staff_working_pattern_days
        WHERE pattern_id = ANY($1::uuid[])`,
      [patterns.map(p => p.id)]
    );
    for (const row of daysRes.rows as PatternDayRow[]) {
      const list = patternDays.get(row.pattern_id);
      if (list) list.push(row);
      else patternDays.set(row.pattern_id, [row]);
    }
  }

  const excRes = await query(
    `SELECT person_id, exception_date::text AS exception_date, is_working,
            start_time::text AS start_time,
            end_time::text   AS end_time,
            minutes
       FROM staff_pattern_exceptions
      WHERE person_id = ANY($1::uuid[])
        AND status = 'approved'
        AND exception_date BETWEEN $2::date AND $3::date`,
    [ids, from, to]
  );
  const exceptions = new Map<string, ExceptionRow>();
  for (const row of excRes.rows as ExceptionRow[]) {
    exceptions.set(`${row.person_id}:${row.exception_date}`, row);
  }

  const dates = dateRange(from, to);

  return people.map(p => {
    const mine = patterns.filter(pt => pt.person_id === p.person_id);
    const days = dates.map(d =>
      resolveScheduledDay(d, mine, patternDays, exceptions.get(`${p.person_id}:${d}`))
    );
    return {
      personId: p.person_id,
      name: p.name,
      preferredName: p.preferred_name,
      jobTitle: p.job_title,
      department: p.department,
      days: maskForViewer(mergeAbsenceLayer(days), opts.isAdmin),
    };
  });
}

/** Single person, single date. Thin wrapper so callers never hand-roll it. */
export async function getDayStatus(personId: string, date: string, isAdmin = false): Promise<StaffDay | null> {
  const [person] = await getStaffCalendar(date, date, { isAdmin, personId });
  return person?.days[0] ?? null;
}

/**
 * Who is in today — the dashboard strip and the "who's around" question.
 * Ordered in, then out, then by name, so the useful half reads first.
 */
export async function getTodaySummary(date: string, isAdmin: boolean) {
  const people = await getStaffCalendar(date, date, { isAdmin });
  const rows = people.map(p => {
    const d = p.days[0];
    return {
      personId: p.personId,
      name: p.preferredName || p.name,
      jobTitle: p.jobTitle,
      status: d.status,
      startTime: d.startTime,
      endTime: d.endTime,
      scheduledMinutes: d.scheduledMinutes,
      window: d.window,
      detail: d.detail,
    };
  });
  const rank = (s: DayStatus) => (s === 'working' ? 0 : s === 'partial' ? 1 : 2);
  rows.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
  return {
    date,
    in: rows.filter(r => r.status === 'working' || r.status === 'partial').length,
    total: rows.length,
    people: rows,
  };
}
