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
 * Phase A implemented the pattern + exception layer; leave (Phase B) and
 * absence (Phase D) merged in at mergeAbsenceLayer() below, which is the single
 * place they attach. No caller changed when either landed, which is what that
 * function exists for. Anything that answers "in or out" in future goes there
 * too, not into a caller.
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
  /**
   * Set when portion = 'hours' — a timed window (spec §7.5). Kept as the FIRST
   * window rather than removed now that a day can carry several, because
   * dropping a field breaks every browser still holding the previous bundle.
   */
  window?: { start: string; end: string };
  /** Every timed window on this day — "in late AND away early" is two. */
  windows?: { start: string; end: string }[];
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

/** One live leave day, as the merge layer needs it. */
export interface LeaveDayOverlay {
  date: string;
  portion: DayPortion;
  leaveType: string;
  status: 'pending' | 'approved';
  /** Set when portion = 'hours' — shown to peers as the window, without a reason. */
  startTime?: string | null;
  endTime?: string | null;
}

/** One live absence day, as the merge layer needs it. */
export interface AbsenceDayOverlay {
  date: string;
  portion: DayPortion;
  absenceType: string;
  startTime: string | null;
  endTime: string | null;
}

/**
 * Overlay leave and absence onto the contracted days.
 *
 * The single attachment point promised in Phase A — leave landed here in B2
 * and absence in D, and no caller changed either time. That was the point of
 * putting it behind one function.
 *
 * A day only becomes 'leave' or 'absent' if it was contracted in the first
 * place: time off on a day someone does not work is meaningless, and letting
 * it render would make the calendar disagree with the ledger (which charged
 * nothing for it).
 *
 * PENDING leave shows as 'partial' rather than 'leave'. It is not time off
 * yet, but everyone — the approver especially — needs to see it is coming,
 * and showing it as confirmed would be a lie the approver then acts on.
 *
 * ABSENCE WINS over leave on the same date. That is the sickness-during-
 * holiday case (§7.4): both rows legitimately exist, because the reclaim
 * deliberately leaves the holiday request intact, and what actually happened
 * to the person that day is the absence. Admin sees both in `detail`; peers
 * see neither, because maskForViewer strips detail entirely.
 */
export function mergeAbsenceLayer(
  days: StaffDay[],
  leave: LeaveDayOverlay[] = [],
  absence: AbsenceDayOverlay[] = []
): StaffDay[] {
  if (leave.length === 0 && absence.length === 0) return days;

  const leaveByDate = new Map(leave.map(l => [l.date, l]));
  const absenceByDate = new Map<string, AbsenceDayOverlay[]>();
  for (const a of absence) {
    const list = absenceByDate.get(a.date) ?? [];
    list.push(a);
    absenceByDate.set(a.date, list);
  }

  return days.map(d => {
    if (d.status !== 'working') return d;
    const l = leaveByDate.get(d.date);
    const abs = absenceByDate.get(d.date) ?? [];
    if (!l && abs.length === 0) return d;

    // Leave detail is carried through even when absence takes the status, so
    // an admin can see that the sickness landed on a booked holiday.
    const leaveDetail = l
      ? { leaveType: l.status === 'approved' ? l.leaveType : `${l.leaveType} (requested)` }
      : {};

    if (abs.length > 0) {
      // A whole day off beats any marker — the unique index means at most one
      // whole/half-day row exists, so this cannot be ambiguous.
      const whole = abs.find(a => a.portion === 'full');
      const windows = abs
        .filter(a => a.startTime && a.endTime)
        .map(a => ({ start: a.startTime!.slice(0, 5), end: a.endTime!.slice(0, 5) }));
      const lead = whole ?? abs[0];

      return {
        ...d,
        status: whole ? 'absent' : 'partial',
        portion: lead.portion,
        ...(windows.length > 0 ? { window: windows[0], windows } : {}),
        detail: { ...leaveDetail, absenceType: lead.absenceType },
      };
    }

    const approved = l!.status === 'approved';
    // Anything short of a whole day is 'partial': they are in for some of it,
    // and the coverage warnings must not count them absent all day. That
    // includes a timed period ('hours') as well as a half day.
    const wholeDay = l!.portion === 'full';
    const win = l!.startTime && l!.endTime
      ? { start: l!.startTime.slice(0, 5), end: l!.endTime.slice(0, 5) }
      : null;

    return {
      ...d,
      status: approved ? (wholeDay ? 'leave' : 'partial') : 'partial',
      portion: l!.portion,
      ...(win ? { window: win, windows: [win] } : {}),
      detail: leaveDetail,
    };
  });
}

/** Live leave days for a set of people over a range, for the merge above. */
export async function getLeaveOverlay(
  personIds: string[], from: string, to: string
): Promise<Map<string, LeaveDayOverlay[]>> {
  if (personIds.length === 0) return new Map();
  const r = await query(
    `SELECT r.person_id, d.leave_date::text AS leave_date, d.portion,
            d.start_time::text AS start_time, d.end_time::text AS end_time,
            r.leave_type, r.status
       FROM staff_leave_request_days d
       JOIN staff_leave_requests r ON r.id = d.request_id
      WHERE d.is_live
        AND d.person_id = ANY($1::uuid[])
        AND d.leave_date BETWEEN $2::date AND $3::date`,
    [personIds, from, to]
  );
  const out = new Map<string, LeaveDayOverlay[]>();
  for (const row of r.rows) {
    const list = out.get(row.person_id) ?? [];
    list.push({
      date: row.leave_date,
      portion: row.portion as DayPortion,
      leaveType: row.leave_type as string,
      status: row.status as 'pending' | 'approved',
      startTime: (row.start_time as string) ?? null,
      endTime: (row.end_time as string) ?? null,
    });
    out.set(row.person_id, list);
  }
  return out;
}

/**
 * Live absence days for a set of people over a range, for the merge above.
 *
 * Catches open absences up to today first: a sickness with no end date cannot
 * have all its day rows written when it starts, so they are filled in lazily
 * (spec §7.1). Doing it on the READ means the read repairs the data and it
 * cannot silently drift — which a nightly job can, and would not tell anyone.
 *
 * The import is dynamic on purpose: staff-absence.ts reads the calendar
 * through this module, so a static import both ways would be a cycle.
 */
export async function getAbsenceOverlay(
  personIds: string[], from: string, to: string
): Promise<Map<string, AbsenceDayOverlay[]>> {
  if (personIds.length === 0) return new Map();

  const { materialiseOpenAbsences } = await import('./staff-absence');
  await materialiseOpenAbsences(personIds);

  const r = await query(
    `SELECT d.person_id, d.absence_date::text AS absence_date, d.portion,
            d.start_time::text AS start_time, d.end_time::text AS end_time,
            a.absence_type
       FROM staff_absence_days d
       JOIN staff_absences a ON a.id = d.absence_id
      WHERE d.is_active
        AND a.status = 'active'
        AND d.person_id = ANY($1::uuid[])
        AND d.absence_date BETWEEN $2::date AND $3::date
      ORDER BY d.absence_date, d.start_time NULLS FIRST`,
    [personIds, from, to]
  );

  const out = new Map<string, AbsenceDayOverlay[]>();
  for (const row of r.rows) {
    const list = out.get(row.person_id) ?? [];
    list.push({
      date: row.absence_date,
      portion: row.portion as DayPortion,
      absenceType: row.absence_type as string,
      startTime: (row.start_time as string) ?? null,
      endTime: (row.end_time as string) ?? null,
    });
    out.set(row.person_id, list);
  }
  return out;
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
  opts: {
    isAdmin: boolean;
    personId?: string;
    /**
     * Overlay live leave onto the contracted days. Default true.
     *
     * Pass false to get the RAW contract — what someone is scheduled to work,
     * ignoring any leave. buildDays() in staff-leave.ts needs that: pricing a
     * new request against a leave-overlaid calendar would silently skip days
     * already booked instead of surfacing the clash.
     */
    includeLeave?: boolean;
    /**
     * Overlay live absence onto the contracted days. Default true.
     *
     * Same reasoning as includeLeave, and buildAbsenceDays() in
     * staff-absence.ts passes false for the same reason: a second absence over
     * the same dates must surface as the clash the database will refuse, not
     * quietly price to nothing.
     */
    includeAbsence?: boolean;
  }
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

  const leaveByPerson = opts.includeLeave === false
    ? new Map<string, LeaveDayOverlay[]>()
    : await getLeaveOverlay(ids, from, to);
  const absenceByPerson = opts.includeAbsence === false
    ? new Map<string, AbsenceDayOverlay[]>()
    : await getAbsenceOverlay(ids, from, to);
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
      days: maskForViewer(
        mergeAbsenceLayer(
          days,
          leaveByPerson.get(p.person_id) ?? [],
          absenceByPerson.get(p.person_id) ?? []
        ),
        opts.isAdmin
      ),
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
