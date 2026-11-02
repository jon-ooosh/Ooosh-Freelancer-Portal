/**
 * Leave requests — book, approve, decline, cancel (Staff Calendar, Phase B2),
 * and changing / cancelling approved time off on request (§5.4.1, Oct 2026).
 *
 * See docs/STAFF-CALENDAR-SPEC.md §3.5, §5, §11.
 *
 * Requests are the WORKFLOW; the ledger is the truth. Approving a request
 * posts a 'booking' debit, cancelling an approved one posts a 'cancellation'
 * credit, and the balance is always the sum of the ledger — never a number
 * cached on the request. Nothing here computes a balance; it asks
 * services/staff-balance.ts.
 *
 * WARNINGS, NOT GATES (the platform rule). Not enough balance, short notice,
 * nobody left to cover — all surfaced, none blocking. A gate with no route
 * through it strands staff, and the one person who can override is the same
 * person doing the approving.
 *
 * Two things are hard refusals, because they corrupt data rather than
 * inconvenience someone: double-booking a date (enforced by a unique index,
 * not just checked here) and requesting leave on days you are not contracted
 * to work.
 */

import { query, getClient } from '../config/database';
import { DATE_RE, dateRange, getStaffCalendar, weekdayIndex } from './staff-day-status';
import { getBalance, postEntry, ensureEntitlement, type LedgerAccount } from './staff-balance';
import { ukToday } from './uk-date';
import { retireLeaveRequestBells } from './staff-notifications';

export type LeaveType = 'holiday' | 'toil' | 'unpaid';
export type LeaveStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'withdrawn';
export type DayPortion = 'full' | 'am' | 'pm' | 'hours';

/** Which ledger account a leave type debits. `unpaid` debits nothing. */
export function accountFor(type: LeaveType): LedgerAccount | null {
  if (type === 'holiday') return 'holiday';
  if (type === 'toil') return 'overtime';
  return null;
}

export interface DraftDay {
  date: string;
  minutes: number;
  portion: DayPortion;
  /** Set when portion = 'hours' — an actual period, e.g. leaving at 15:00. */
  startTime?: string | null;
  endTime?: string | null;
}

/**
 * What the caller asks for on a given date: a whole day, a half, or a period.
 * 'none' — "not off that day" — takes one day out of a range (changing a
 * booking, spec §5.4). It is never stored: a day not taken simply has no row,
 * exactly like a weekend.
 */
export interface DaySpec {
  portion: DayPortion | 'none';
  startTime?: string | null;
  endTime?: string | null;
}

export interface LeaveRequest {
  id: string;
  personId: string;
  personName: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalMinutes: number;
  status: LeaveStatus;
  requestNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  cancellationReason: string | null;
  days: { date: string; minutes: number; portion: DayPortion; startTime: string | null; endTime: string | null }[];
  /**
   * Set on a CHANGE (spec §5.4): the approved booking this one replaces once
   * approved. Until then the original stands untouched.
   */
  replacesRequestId: string | null;
  /** The booking a change replaces, as it stands — for "was X, now Y". */
  replaces: { startDate: string; endDate: string; totalMinutes: number; leaveType: LeaveType; status: LeaveStatus } | null;
  /** On an approved booking: a change waiting to replace it. */
  pendingChangeId: string | null;
  /** On a booking cancelled BY a change: the booking that replaced it. */
  replacedById: string | null;
  /**
   * On an approved booking: the person's written ask to cancel it, and the
   * answer if it was declined. Waiting = status 'approved', asked, not declined.
   */
  cancelAsk: { requestedAt: string; note: string | null; declinedAt: string | null; declineNote: string | null } | null;
}

/** An ask to cancel that nobody has answered yet. */
export function isCancelAskWaiting(r: LeaveRequest): boolean {
  return r.status === 'approved' && !!r.cancelAsk && !r.cancelAsk.declinedAt;
}

// ── Building the days ───────────────────────────────────────────────────────

/**
 * Turn a date range into the days it actually costs.
 *
 * Non-working days produce NO row — request Friday to Monday and a weekend is
 * simply not charged. The minutes come from the working pattern in force NOW
 * and are then frozen on the row (spec §0.3), so a later hours change cannot
 * retroactively re-price an approved holiday.
 */
export async function buildDays(
  personId: string,
  startDate: string,
  endDate: string,
  dayOverrides: Record<string, DaySpec | DayPortion> = {}
): Promise<DraftDay[]> {
  return (await buildDaysDetailed(personId, startDate, endDate, dayOverrides)).days;
}

/**
 * buildDays, plus the contracted days the caller marked 'none' (not off). The
 * form needs those back: a day marked "not off" drops out of `days`, and
 * without this it would vanish from the list and could not be put back.
 */
async function buildDaysDetailed(
  personId: string,
  startDate: string,
  endDate: string,
  dayOverrides: Record<string, DaySpec | DayPortion>
): Promise<{ days: DraftDay[]; notOff: string[] }> {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw new Error('Dates must be YYYY-MM-DD');
  if (endDate < startDate) throw new Error('The end date must be on or after the start date');
  if (dateRange(startDate, endDate).length > 366) throw new Error('A single request cannot span more than a year');

  // Raw contract, NOT leave-overlaid — see the includeLeave note on
  // getStaffCalendar. An overlap must surface as a clash, never as a day that
  // quietly vanishes from the request.
  const [person] = await getStaffCalendar(startDate, endDate,
    { isAdmin: true, personId, includeLeave: false });
  if (!person) throw new Error('No staff record for this person');

  const out: DraftDay[] = [];
  const notOff: string[] = [];
  for (const day of person.days) {
    if (day.status !== 'working' || day.scheduledMinutes <= 0) continue;

    const raw = dayOverrides[day.date];
    const spec: DaySpec = typeof raw === 'string' ? { portion: raw } : (raw ?? { portion: 'full' });

    if (spec.portion === 'none') { notOff.push(day.date); continue; }

    if (spec.portion === 'hours') {
      // A timed period: the duration IS the charge. Costing it any other way
      // would make an early finish either free or a full day, and neither is
      // what happened.
      if (!spec.startTime || !spec.endTime) {
        throw new Error(`A timed period on ${day.date} needs both a start and an end time`);
      }
      const minutes = minutesBetweenTimes(spec.startTime, spec.endTime);
      if (minutes <= 0) throw new Error(`The end time on ${day.date} must be after the start`);
      if (minutes > day.scheduledMinutes) {
        throw new Error(
          `${day.date}: that period is longer than the ${Math.round(day.scheduledMinutes / 60 * 10) / 10}h they are contracted to work that day`
        );
      }
      out.push({
        date: day.date, minutes, portion: 'hours',
        startTime: spec.startTime, endTime: spec.endTime,
      });
      continue;
    }

    const minutes = spec.portion === 'full'
      ? day.scheduledMinutes
      : Math.round(day.scheduledMinutes / 2);
    if (minutes <= 0) continue;
    out.push({ date: day.date, minutes, portion: spec.portion });
  }
  return { days: out, notOff };
}

// ── Changing an approved booking (spec §5.4) ────────────────────────────────

/** The same booking of a date: same portion, same times (seconds ignored). */
function sameDay(
  a: { portion: string; startTime?: string | null; endTime?: string | null },
  b: { portion: string; startTime?: string | null; endTime?: string | null },
): boolean {
  const t = (x?: string | null) => (x ?? '').slice(0, 5);
  return a.portion === b.portion && t(a.startTime) === t(b.startTime) && t(a.endTime) === t(b.endTime);
}

/** "Mon 2 Nov" / "Mon 2 Nov – Fri 6 Nov", for reasons people read. */
function fmtRange(a: string, b: string): string {
  const f = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  return a === b ? f(a) : `${f(a)} – ${f(b)}`;
}

/**
 * Dates on a booking whose time was already given back by another route — a
 * sickness reclaim (§7.4) or a company day granted over it (§20). Their credit
 * has been posted; cancelling the booking must not post it again.
 */
async function handedBackDates(requestId: string): Promise<Set<string>> {
  const r = await query(
    `SELECT leave_date::text AS leave_date
       FROM staff_leave_request_days
      WHERE request_id = $1
        AND (reclaimed_absence_id IS NOT NULL OR reclaimed_company_day_id IS NOT NULL)`,
    [requestId]
  );
  return new Set(r.rows.map((x: { leave_date: string }) => x.leave_date));
}

/**
 * Throw unless `original` is an approved booking of this person's that can
 * still be asked about. Shared by the change and the cancel ask, so the two
 * cannot disagree about what is changeable.
 */
function assertOpenBooking(original: LeaveRequest | null, personId: string): asserts original is LeaveRequest {
  if (!original || original.personId !== personId) throw new Error('Booking not found');
  if (original.status !== 'approved') {
    throw new Error(original.status === 'pending'
      ? 'That request is still waiting — withdraw it and book again instead'
      : `Only an approved booking can be changed (this one is ${original.status})`);
  }
  const today = ukToday();
  if (original.days.length === 0 || original.days.every(d => d.date < today)) {
    throw new Error('That booking has finished — days already gone can’t be changed');
  }
  if (original.pendingChangeId) throw new Error('A change to this booking is already waiting — withdraw it first');
  if (isCancelAskWaiting(original)) throw new Error('There’s already an ask to cancel this booking — withdraw that first');
}

/**
 * The days a CHANGE would book.
 *
 * Days before `lockBefore` have gone — "today" for a change being asked, the
 * day it was asked for one waiting on approval. They must stay exactly as they
 * were booked, and they are carried over from the original VERBATIM (minutes
 * included) rather than re-priced, so a change can never re-cost or move a day
 * already taken (jon, Oct 2026: the past is corrected by an admin, never
 * edited by a change).
 */
async function planChangeDays(
  original: LeaveRequest, leaveType: LeaveType, startDate: string, endDate: string,
  overrides: Record<string, DaySpec | DayPortion>, lockBefore: string,
): Promise<{ days: DraftDay[]; notOff: string[] }> {
  // The type is part of how a day was taken: switching a holiday under way to
  // unpaid would quietly re-label the days already gone.
  if (leaveType !== original.leaveType && original.days.some(d => d.date < lockBefore)) {
    throw new Error('It’s already started, so its type can’t change — only the days left');
  }
  const built = await buildDaysDetailed(original.personId, startDate, endDate, overrides);
  const specFor = (date: string): DaySpec => {
    const raw = overrides[date];
    return typeof raw === 'string' ? { portion: raw } : (raw ?? { portion: 'full' });
  };
  const gone = original.days.filter(d => d.date < lockBefore);
  // Every day already gone is still asked for, and asked for as it was.
  const dropped = gone.filter(o =>
    o.date < startDate || o.date > endDate || !sameDay(specFor(o.date), o));
  // And nothing has been added before it, either.
  const added = built.days.filter(d =>
    d.date < lockBefore && !gone.some(o => o.date === d.date));
  if (dropped.length > 0 || added.length > 0) {
    throw new Error('Days that have already gone can’t be changed — only today onwards');
  }
  const days: DraftDay[] = [
    ...gone.map(o => ({ date: o.date, minutes: o.minutes, portion: o.portion, startTime: o.startTime, endTime: o.endTime })),
    ...built.days.filter(d => d.date >= lockBefore),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return { days, notOff: built.notOff.filter(d => d >= lockBefore) };
}

/** Dates a change adds or alters — the ones whose cover and notice matter. */
function changedDates(original: LeaveRequest, days: DraftDay[]): string[] {
  return days
    .filter(d => !original.days.some(o => o.date === d.date && sameDay(o, d)))
    .map(d => d.date);
}

/** Minutes between two HH:MM(:SS) clock times. */
export function minutesBetweenTimes(start: string, end: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(end) - toMin(start);
}

// ── The impact preview (spec §5.2) ──────────────────────────────────────────

export interface LeaveImpact {
  days: DraftDay[];
  totalMinutes: number;
  workingDays: number;
  account: LedgerAccount | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  nominalDayMinutes: number | null;
  shortfallMinutes: number;
  /**
   * The cost split by leave year. Almost always one entry; two when a request
   * straddles 31 December, which is the case that used to be mispriced.
   */
  perYear: {
    year: number; minutes: number;
    balanceBefore: number; balanceAfter: number; shortfallMinutes: number;
  }[];
  noticeDays: number;
  /** Dates the requester has ALREADY booked off — a blocker, not a warning. */
  ownClashes: string[];
  /** Who else is already off on any of these dates. */
  clashes: { date: string; people: string[] }[];
  /** Contracted headcount per date once this request is taken off. */
  coverage: { date: string; scheduled: number; ifApproved: number }[];
  warnings: string[];
  /** Contracted days in the range marked "not off" — so the form can show them. */
  notOff: string[];
  /**
   * Only for a CHANGE (spec §5.4), else null. `minutes` is the NET effect on
   * this account — positive uses more, negative gives time back — and
   * `changedDates` the days it adds or alters, which are the only ones cover,
   * clashes and notice are checked for: the rest were approved already.
   */
  change: { replacesRequestId: string; minutes: number; changedDates: string[]; unchanged: boolean } | null;
}

/**
 * What would happen if this were approved.
 *
 * Shown to the REQUESTER before they submit as well as to the approver — the
 * best clash is the one that never gets requested. Every finding is a warning.
 */
export async function getImpact(
  personId: string, startDate: string, endDate: string, leaveType: LeaveType,
  dayOverrides: Record<string, DaySpec | DayPortion> = {}, excludeRequestId?: string,
  /**
   * Set when this is a CHANGE to an approved booking. `lockBefore` is the
   * first date that may still change — today, or the day a waiting change was
   * asked for (so an approver looking at it later sees what was asked).
   */
  change?: { replacesRequestId: string; lockBefore?: string },
): Promise<LeaveImpact> {
  let original: LeaveRequest | null = null;
  let built: { days: DraftDay[]; notOff: string[] };
  if (change) {
    original = await getRequest(change.replacesRequestId);
    if (!original || original.personId !== personId) throw new Error('Booking not found');
    built = await planChangeDays(original, leaveType, startDate, endDate, dayOverrides, change.lockBefore ?? ukToday());
  } else {
    built = await buildDaysDetailed(personId, startDate, endDate, dayOverrides);
  }
  const days = built.days;
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
  const account = accountFor(leaveType);

  // A change gives the original's time back and takes the new days' time.
  // Days already handed back (sickness, a company day) are neither — on
  // approval the new booking inherits that, so the preview must too.
  const handedBack = original ? await handedBackDates(original.id) : new Set<string>();
  const creditByYear = new Map<number, number>();
  if (original && accountFor(original.leaveType) === account) {
    for (const d of original.days) {
      if (handedBack.has(d.date)) continue;
      const y = Number(d.date.slice(0, 4));
      creditByYear.set(y, (creditByYear.get(y) ?? 0) + d.minutes);
    }
  }

  // PER LEAVE YEAR, because a request can straddle 31 December and the ledger
  // already does: approveRequest posts one debit per day into that day's own
  // leave year. Pricing the whole request against the START year — which this
  // did — meant a 28 Dec–4 Jan request was checked entirely against December's
  // balance and then quietly put January's into deficit on approval. The
  // preview and the ledger disagreed, which is the failure mode this codebase
  // is most prone to.
  const minutesByYear = new Map<number, number>();
  for (const d of days) {
    if (handedBack.has(d.date)) continue;
    const y = Number(d.date.slice(0, 4));
    minutesByYear.set(y, (minutesByYear.get(y) ?? 0) + d.minutes);
  }
  // A change's figure is the NET: what it takes minus what it gives back.
  for (const [y, credit] of creditByYear) {
    minutesByYear.set(y, (minutesByYear.get(y) ?? 0) - credit);
  }
  // A request with no chargeable days still needs a year to report against.
  if (minutesByYear.size === 0) minutesByYear.set(Number(startDate.slice(0, 4)), 0);

  const perYear: LeaveImpact['perYear'] = [];
  let balanceBefore: number | null = null;
  let nominalDayMinutes: number | null = null;
  let shortfallMinutes = 0;

  if (account) {
    for (const [y, mins] of [...minutesByYear.entries()].sort((a, b) => a[0] - b[0])) {
      // Booking into a year whose entitlement the nightly sync has not granted
      // yet would report the whole request as a shortfall. Holiday only — the
      // overtime bank is earned, never granted.
      if (account === 'holiday') await ensureEntitlement(personId, y);
      const bal = await getBalance(personId, account, y);
      const after = bal.balanceMinutes - mins;
      // Only something that TAKES time can be short. A change that gives time
      // back to a balance already in the red is not "more than they have left".
      const short = after < 0 && mins > 0 ? -after : 0;
      perYear.push({
        year: y, minutes: mins,
        balanceBefore: bal.balanceMinutes, balanceAfter: after,
        shortfallMinutes: short,
      });
      shortfallMinutes += short;
      // The headline figures stay the FIRST year's, so the existing shape keeps
      // meaning what it always did for the overwhelmingly common single-year
      // request. perYear is the additive field that tells the whole story.
      if (balanceBefore === null) {
        balanceBefore = bal.balanceMinutes;
        nominalDayMinutes = bal.nominalDayMinutes;
      }
    }
  }
  const balanceAfter = balanceBefore === null
    ? null
    : balanceBefore - (minutesByYear.get(perYear[0]?.year ?? 0) ?? 0);

  const today = ukToday();
  // A change is only checked on the days it adds or alters — the others were
  // approved already, and re-warning about them is noise that teaches people
  // to ignore the panel.
  const changed = original ? changedDates(original, days) : null;
  const dateList = changed ?? days.map(d => d.date);
  const noticeFrom = changed ? (changed[0] ?? null) : startDate;
  const noticeDays = noticeFrom ? Math.max(0, dateRange(today, noticeFrom).length - 1) : 0;

  // Everyone else's live leave over the same dates.
  const clashes: { date: string; people: string[] }[] = [];
  const coverage: { date: string; scheduled: number; ifApproved: number }[] = [];

  if (dateList.length > 0) {
    const others = await query(
      `SELECT d.leave_date::text AS leave_date,
              (p.first_name || ' ' || p.last_name) AS name
         FROM staff_leave_request_days d
         JOIN staff_leave_requests r ON r.id = d.request_id
         JOIN people p ON p.id = r.person_id
        WHERE d.is_live
          AND d.leave_date = ANY($1::date[])
          AND r.person_id <> $2
          AND ($3::uuid IS NULL OR r.id <> $3::uuid)
        ORDER BY d.leave_date, p.first_name`,
      [dateList, personId, excludeRequestId ?? null]
    );
    const byDate = new Map<string, string[]>();
    for (const row of others.rows) {
      const list = byDate.get(row.leave_date) ?? [];
      list.push(row.name);
      byDate.set(row.leave_date, list);
    }
    for (const [date, people] of byDate) clashes.push({ date, people });

    // Headcount per date. This calendar IS leave-overlaid, so anyone already
    // off is already absent from `scheduled` — subtracting them again (as an
    // earlier version did) double-counts and under-reports cover. The only
    // person still to remove is the requester, who is working that day by
    // definition or the day would not be in this list.
    //
    // Cover means people in the BUILDING (spec §19): somebody working from
    // home cannot take a delivery, so they are not counted — and if the
    // requester was going to be at home anyway, approving costs no cover.
    const team = await getStaffCalendar(dateList[0], dateList[dateList.length - 1], { isAdmin: true });
    const onSite = (d: { status: string; location?: string } | undefined) =>
      d?.status === 'working' && d.location !== 'home';
    for (const date of dateList) {
      const scheduled = team.filter(t => onSite(t.days.find(x => x.date === date))).length;
      const requesterHere = onSite(team.find(t => t.personId === personId)?.days.find(x => x.date === date));
      coverage.push({ date, scheduled, ifApproved: Math.max(0, scheduled - (requesterHere ? 1 : 0)) });
    }
  }

  // The person's OWN live leave over these dates. The unique index refuses the
  // booking outright, so this exists to say so BEFORE they submit rather than
  // after — the same fact, delivered early. Over EVERY day, not just changed
  // ones, and never counting the booking a change replaces.
  let ownClashes: string[] = [];
  const allDates = days.map(d => d.date);
  if (allDates.length > 0) {
    const own = await query(
      `SELECT d.leave_date::text AS leave_date
         FROM staff_leave_request_days d
         JOIN staff_leave_requests r ON r.id = d.request_id
        WHERE d.is_live AND d.person_id = $1
          AND d.leave_date = ANY($2::date[])
          AND ($3::uuid IS NULL OR r.id <> $3::uuid)
          AND ($4::uuid IS NULL OR r.id <> $4::uuid)
        ORDER BY d.leave_date`,
      [personId, allDates, excludeRequestId ?? null, original?.id ?? null]
    );
    ownClashes = own.rows.map((r: { leave_date: string }) => r.leave_date);
  }

  const warnings: string[] = [];
  if (ownClashes.length > 0) {
    warnings.push(
      `Already booked off on ${ownClashes.join(', ')} — cancel that first, or pick other dates.`
    );
  }
  if (days.length === 0) {
    warnings.push(original
      ? 'That leaves no days off — to give the whole booking back, cancel it instead.'
      : 'None of those dates are days this person is contracted to work.');
  }
  // Only possible on a change that waited: asked in time, looked at late.
  for (const d of (changed ?? []).filter(x => x < today)) {
    warnings.push(`${fmtRange(d, d)} has already gone — approving still changes it.`);
  }
  if (shortfallMinutes > 0) {
    const bank = leaveType === 'toil' ? ' in the overtime bank' : '';
    if (perYear.length > 1) {
      // Naming the year matters here: "you are 14h over" is baffling when half
      // the request is in a year you have barely touched.
      for (const y of perYear.filter(x => x.shortfallMinutes > 0)) {
        warnings.push(
          `This is ${fmtMins(y.shortfallMinutes)} more than they have left${bank} in ${y.year}.`
        );
      }
    } else {
      warnings.push(`This is ${fmtMins(shortfallMinutes)} more than they have left${bank}.`);
    }
  }
  const { getNoticeDaysWarning } = await import('./staff-settings');
  const noticeThreshold = await getNoticeDaysWarning();
  if (noticeDays < noticeThreshold && dateList.length > 0) {
    warnings.push(`Only ${noticeDays} day${noticeDays === 1 ? '' : 's'}' notice.`);
  }
  // Coverage floor, per weekday (spec §13 `staff.min_headcount_by_weekday`).
  // With nothing configured this keeps the behaviour it has always had —
  // shout when a day would drop to one person or nobody — so an empty setting
  // is not a silent loss of the warning.
  const { getMinHeadcountByWeekday } = await import('./staff-settings');
  const floors = await getMinHeadcountByWeekday();
  for (const c of coverage) {
    const floor = floors[String(weekdayIndex(c.date))];
    if (floor !== undefined) {
      if (c.ifApproved < floor) {
        warnings.push(
          `${c.date} would have ${c.ifApproved} in, and you want at least ${floor}.`
        );
      }
      continue;
    }
    if (c.ifApproved <= 1) {
      warnings.push(
        c.ifApproved === 0
          ? `Nobody would be in on ${c.date}.`
          : `Only one person would be in on ${c.date}.`
      );
    }
  }

  return {
    days, totalMinutes, workingDays: days.length, account,
    balanceBefore, balanceAfter, nominalDayMinutes, shortfallMinutes, perYear,
    noticeDays, ownClashes, clashes, coverage, warnings,
    notOff: built.notOff,
    change: original
      ? {
          replacesRequestId: original.id,
          // Unpaid leave has no account, so it neither takes nor gives back.
          minutes: account ? [...minutesByYear.values()].reduce((s, m) => s + m, 0) : 0,
          changedDates: changed ?? [],
          // Still the booking as it stands — the form says so rather than
          // offering a "change" the server would refuse.
          unchanged: leaveType === original.leaveType
            && days.length === original.days.length
            && (changed ?? []).length === 0,
        }
      : null,
  };
}

function fmtMins(m: number): string {
  const h = Math.floor(Math.abs(m) / 60), mm = Math.abs(m) % 60;
  return h === 0 ? `${mm}m` : mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

// ── Create / decide / cancel ────────────────────────────────────────────────

export async function createRequest(input: {
  personId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  halfDays?: Record<string, DaySpec | DayPortion>;
  note?: string | null;
  /**
   * A CHANGE to an approved booking (spec §5.4): this request replaces it once
   * approved. Until then the original stands, and this one's days are not live.
   */
  replacesRequestId?: string | null;
}, userId: string): Promise<string> {
  let original: LeaveRequest | null = null;
  let days: DraftDay[];
  let startDate = input.startDate;
  let endDate = input.endDate;
  if (input.replacesRequestId) {
    original = await getRequest(input.replacesRequestId);
    assertOpenBooking(original, input.personId);
    // The written record is the point (jon, Oct 2026).
    if (!input.note?.trim()) throw new Error('Say why it’s changing — a note is required');
    ({ days } = await planChangeDays(original, input.leaveType, startDate, endDate, input.halfDays ?? {}, ukToday()));
    if (days.length === 0) {
      throw new Error('That leaves no days off — to give the whole booking back, cancel it instead');
    }
    const same = input.leaveType === original.leaveType
      && days.length === original.days.length
      && days.every(d => original!.days.some(o => o.date === d.date && sameDay(o, d)));
    if (same) throw new Error('That’s the booking as it already is — nothing to change');
    // Days kept from before today may sit outside the range asked for; the
    // row's range must still cover every day it holds.
    if (days[0].date < startDate) startDate = days[0].date;
    if (days[days.length - 1].date > endDate) endDate = days[days.length - 1].date;
  } else {
    days = await buildDays(input.personId, startDate, endDate, input.halfDays ?? {});
    if (days.length === 0) {
      throw new Error('None of those dates are days this person is contracted to work');
    }
  }
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (original) {
      // A change's days are not live while it waits (they would clash with the
      // booking they replace), so the no-double-booking index cannot check
      // them against the person's OTHER bookings. Check here instead; the
      // index still has the last word when the change is approved.
      const clash = await client.query(
        `SELECT leave_date::text AS leave_date
           FROM staff_leave_request_days
          WHERE is_live AND person_id = $1
            AND leave_date = ANY($2::date[])
            AND request_id <> $3
          ORDER BY leave_date`,
        [input.personId, days.map(d => d.date), original.id]
      );
      if (clash.rows.length > 0) {
        throw new Error(`Already booked off on ${clash.rows.map((x: { leave_date: string }) => x.leave_date).join(', ')} — on another booking`);
      }
    }

    const r = await client.query(
      `INSERT INTO staff_leave_requests
         (person_id, leave_type, start_date, end_date, total_minutes, request_note, requested_by,
          replaces_request_id)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8)
       RETURNING id`,
      [input.personId, input.leaveType, startDate, endDate,
       totalMinutes, input.note ?? null, userId, original?.id ?? null]
    );
    const id = r.rows[0].id as string;

    for (const d of days) {
      await client.query(
        `INSERT INTO staff_leave_request_days
           (request_id, person_id, leave_date, minutes, portion, start_time, end_time, is_live)
         VALUES ($1,$2,$3::date,$4,$5,$6::time,$7::time,$8)`,
        [id, input.personId, d.date, d.minutes, d.portion, d.startTime ?? null, d.endTime ?? null,
         original === null]
      );
    }
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    // The unique index is the real guard against double-booking; translate it
    // into something a human can act on rather than leaking a constraint name.
    if (err instanceof Error && err.message.includes('idx_staff_leave_no_double_booking')) {
      throw new Error('Some of those dates are already booked off — cancel the existing request first');
    }
    if (err instanceof Error && err.message.includes('idx_staff_leave_one_pending_change')) {
      throw new Error('A change to this booking is already waiting — withdraw it first');
    }
    throw err;
  } finally {
    client.release();
  }
}

type DbClient = Awaited<ReturnType<typeof getClient>>;

/**
 * Give an approved request's time back: one 'cancellation' credit per day,
 * mirroring its debits. A day whose time was already given back (a sickness
 * reclaim, a company day granted over it) is skipped — it has had its credit,
 * and crediting it again would hand the same day back twice.
 */
async function postCancellationCredits(client: DbClient, req: LeaveRequest, note: string, userId: string) {
  const account = accountFor(req.leaveType);
  if (!account) return;
  const days = await client.query(
    `SELECT leave_date::text AS leave_date, minutes
       FROM staff_leave_request_days
      WHERE request_id = $1
        AND reclaimed_absence_id IS NULL AND reclaimed_company_day_id IS NULL
      ORDER BY leave_date`,
    [req.id]
  );
  for (const d of days.rows as { leave_date: string; minutes: number }[]) {
    await client.query(
      `INSERT INTO staff_ledger_entries
         (person_id, account, leave_year, entry_type, minutes, effective_date,
          source_type, source_id, note, created_by)
       VALUES ($1,$2,$3,'cancellation',$4,$5::date,'leave_request',$6,$7,$8)`,
      [req.personId, account, Number(d.leave_date.slice(0, 4)), Number(d.minutes), d.leave_date,
       req.id, note, userId]
    );
  }
}

/**
 * Approve, and post the ledger debit in the SAME transaction.
 *
 * If the ledger insert fails the approval must not stand, or the calendar
 * would show time off that no balance ever paid for.
 */
export async function approveRequest(requestId: string, note: string | null, userId: string) {
  const req = await getRequest(requestId);
  if (!req) throw new Error('Request not found');
  if (req.status !== 'pending') throw new Error(`That request is already ${req.status}`);

  // A CHANGE (spec §5.4) also cancels the booking it replaces — in the same
  // transaction, so the person is never left with neither, or with both.
  const original = req.replacesRequestId ? await getRequest(req.replacesRequestId) : null;
  if (req.replacesRequestId && !original) throw new Error('The booking this changes no longer exists');

  const account = accountFor(req.leaveType);
  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (original) {
      const off = await client.query(
        `UPDATE staff_leave_requests
            SET status='cancelled', cancelled_by=$2, cancelled_at=NOW(),
                cancellation_reason=$3, updated_at=NOW()
          WHERE id=$1 AND status='approved'
          RETURNING id`,
        // The day count matters: taking a day out of the middle leaves the
        // same two end dates, and "Changed to Mon – Fri" would say nothing.
        [original.id, userId,
         `Changed to ${fmtRange(req.startDate, req.endDate)} (${req.days.length} day${req.days.length === 1 ? '' : 's'})${req.requestNote ? ` — ${req.requestNote}` : ''}`]
      );
      if (off.rows.length === 0) {
        throw new Error('The booking this changes is no longer approved — decline the change instead');
      }
      await postCancellationCredits(client, original,
        `Changed to ${fmtRange(req.startDate, req.endDate)}`, userId);
      // A day already given back on the original stays given back on its
      // replacement — otherwise the change would quietly charge it again.
      await client.query(
        `UPDATE staff_leave_request_days n
            SET reclaimed_absence_id = o.reclaimed_absence_id,
                reclaimed_company_day_id = o.reclaimed_company_day_id
           FROM staff_leave_request_days o
          WHERE n.request_id = $1 AND o.request_id = $2
            AND o.leave_date = n.leave_date
            AND (o.reclaimed_absence_id IS NOT NULL OR o.reclaimed_company_day_id IS NOT NULL)`,
        [req.id, original.id]
      );
    }

    // For a change, the status trigger makes its days live here — AFTER the
    // original's went dead above, so the no-double-booking index never sees both.
    const upd = await client.query(
      `UPDATE staff_leave_requests
          SET status='approved', decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
        WHERE id=$1 AND status='pending'
        RETURNING id`,
      [requestId, userId, note]
    );
    // The status check above ran before the transaction. Two presses at once
    // both pass it; only one of them flips the row, and the other must not go
    // on to post a second debit (Oct 2026). Throwing rolls it back.
    if (upd.rows.length === 0) throw new Error('That request has already been decided');

    if (account) {
      // The debit type is PER ACCOUNT: spending the overtime bank on a day off
      // is 'spend_toil', not 'booking' (which is holiday-only). Migration 208's
      // per-account constraint refuses the wrong one outright — which is how
      // this was caught, having shipped broken in B2.
      const debitType = account === 'overtime' ? 'spend_toil' : 'booking';
      // One debit per day, so the ledger reads as the days actually taken and
      // a later single-day reclaim (sickness during holiday) has something to
      // reverse. effective_date is the day off, not the day approved. A day
      // already given back (only ever inherited by a change, above) is not
      // charged.
      const days = await client.query(
        `SELECT leave_date::text AS leave_date, minutes, portion
           FROM staff_leave_request_days
          WHERE request_id = $1
            AND reclaimed_absence_id IS NULL AND reclaimed_company_day_id IS NULL
          ORDER BY leave_date`,
        [requestId]
      );
      for (const d of days.rows as { leave_date: string; minutes: number; portion: string }[]) {
        await client.query(
          `INSERT INTO staff_ledger_entries
             (person_id, account, leave_year, entry_type, minutes, effective_date,
              source_type, source_id, note, created_by)
           VALUES ($1,$2,$3,$9,$4,$5::date,'leave_request',$6,$7,$8)`,
          [req.personId, account, Number(d.leave_date.slice(0, 4)), -Number(d.minutes), d.leave_date,
           requestId, `${req.leaveType} — ${d.portion === 'full' ? 'full day' : d.portion}`,
           userId, debitType]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof Error && err.message.includes('idx_staff_leave_no_double_booking')) {
      throw new Error('Some of those dates have been booked off on another request since — sort that one out first');
    }
    throw err;
  } finally {
    client.release();
  }
  // No longer waiting — every approver's bell for it is done with. For a
  // change, any bell still on the original (an ask to cancel it) is done too.
  await retireLeaveRequestBells(requestId);
  if (original) await retireLeaveRequestBells(original.id);
}

export async function declineRequest(requestId: string, note: string, userId: string) {
  const r = await query(
    `UPDATE staff_leave_requests
        SET status='declined', decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
      WHERE id=$1 AND status='pending'
      RETURNING id`,
    [requestId, userId, note]
  );
  if (r.rows.length === 0) throw new Error('That request is no longer pending');
  await retireLeaveRequestBells(requestId);
}

/** Withdraw a request of your own that has not been decided yet. */
export async function withdrawRequest(requestId: string, personId: string) {
  const r = await query(
    `UPDATE staff_leave_requests
        SET status='withdrawn', updated_at=NOW()
      WHERE id=$1 AND person_id=$2 AND status='pending'
      RETURNING id`,
    [requestId, personId]
  );
  if (r.rows.length === 0) throw new Error('That request is no longer pending');
  await retireLeaveRequestBells(requestId);
}

/**
 * Cancel an APPROVED request and give the time back.
 *
 * The credit is posted per day and mirrors the booking, so the ledger shows
 * the booking and its cancellation as two visible facts rather than a hole
 * where a booking used to be.
 */
export async function cancelRequest(requestId: string, reason: string, userId: string) {
  const req = await getRequest(requestId);
  if (!req) throw new Error('Request not found');
  if (req.status !== 'approved') throw new Error(`Only an approved request can be cancelled (this one is ${req.status})`);
  // Days already gone are never given back by a cancel (jon, Oct 2026) — a
  // holiday under way is shortened with a change, which keeps them.
  if (req.days.some(d => d.date < ukToday())) {
    throw new Error('This time off has already started — days already gone can’t be given back. Change it to drop the days left instead.');
  }
  if (req.pendingChangeId) {
    throw new Error('A change to this booking is waiting — approve or decline that first');
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE staff_leave_requests
          SET status='cancelled', cancelled_by=$2, cancelled_at=NOW(),
              cancellation_reason=$3, updated_at=NOW()
        WHERE id=$1 AND status='approved'
        RETURNING id`,
      [requestId, userId, reason]
    );
    // Same race as approveRequest: only the press that flips the row gives
    // the time back, or it is credited twice.
    if (upd.rows.length === 0) throw new Error('That request has already been cancelled');
    await postCancellationCredits(client, req, `Cancelled: ${reason}`, userId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // An ask to cancel it, if there was one, has been answered.
  await retireLeaveRequestBells(requestId);
}

// ── Asking to cancel approved time off (spec §5.4) ──────────────────────────
//
// A cancel ask has no days of its own, so it lives on the booking: asked
// (cancel_requested_*), then either approved — the ordinary cancel above — or
// declined (cancel_declined_*), when the booking stands and the person is told
// why. Asking again after a decline starts a fresh ask.

/** The person asks, in writing, to cancel their own approved time off. */
export async function askToCancel(requestId: string, personId: string, note: string, userId: string) {
  const req = await getRequest(requestId);
  assertOpenBooking(req, personId);
  if (req.days.some(d => d.date < ukToday())) {
    throw new Error('This time off has already started — ask to change it instead, dropping the days left');
  }
  const r = await query(
    `UPDATE staff_leave_requests
        SET cancel_requested_at = NOW(), cancel_requested_by = $3, cancel_request_note = $4,
            cancel_declined_at = NULL, cancel_declined_by = NULL, cancel_decline_note = NULL,
            updated_at = NOW()
      WHERE id = $1 AND person_id = $2 AND status = 'approved'
        AND (cancel_requested_at IS NULL OR cancel_declined_at IS NOT NULL)
      RETURNING id`,
    [requestId, personId, userId, note]
  );
  if (r.rows.length === 0) throw new Error('That booking has changed since — reload and try again');
}

/** The person takes back an ask to cancel that nobody has answered yet. */
export async function withdrawCancelAsk(requestId: string, personId: string) {
  const r = await query(
    `UPDATE staff_leave_requests
        SET cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_request_note = NULL,
            updated_at = NOW()
      WHERE id = $1 AND person_id = $2 AND status = 'approved'
        AND cancel_requested_at IS NOT NULL AND cancel_declined_at IS NULL
      RETURNING id`,
    [requestId, personId]
  );
  if (r.rows.length === 0) throw new Error('There’s no ask to cancel waiting on that booking');
  await retireLeaveRequestBells(requestId);
}

/** An admin says yes: the ordinary cancel, with their note as the reason. */
export async function approveCancelAsk(requestId: string, userId: string) {
  const req = await getRequest(requestId);
  if (!req || !isCancelAskWaiting(req)) throw new Error('There’s no ask to cancel waiting on that booking');
  await cancelRequest(requestId, req.cancelAsk!.note || 'Asked to cancel', userId);
}

/** An admin says no: the booking stands, and the person is told why. */
export async function declineCancelAsk(requestId: string, note: string, userId: string) {
  const r = await query(
    `UPDATE staff_leave_requests
        SET cancel_declined_at = NOW(), cancel_declined_by = $2, cancel_decline_note = $3,
            updated_at = NOW()
      WHERE id = $1 AND status = 'approved'
        AND cancel_requested_at IS NOT NULL AND cancel_declined_at IS NULL
      RETURNING id`,
    [requestId, userId, note]
  );
  if (r.rows.length === 0) throw new Error('There’s no ask to cancel waiting on that booking');
  await retireLeaveRequestBells(requestId);
}

// ── Reads ───────────────────────────────────────────────────────────────────

// One SELECT for both reads, so a request means the same thing wherever it is
// listed. The change and cancel-ask fields are spec §5.4.
const REQUEST_SELECT = `
  SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date,
         (p.first_name || ' ' || p.last_name) AS person_name,
         (dp.first_name || ' ' || dp.last_name) AS decided_by_name,
         o.start_date::text AS replaces_start_date, o.end_date::text AS replaces_end_date,
         o.total_minutes AS replaces_total_minutes, o.leave_type AS replaces_leave_type,
         o.status AS replaces_status,
         (SELECT c.id FROM staff_leave_requests c
           WHERE c.replaces_request_id = r.id AND c.status = 'pending' LIMIT 1) AS pending_change_id,
         -- 'cancelled' too: a replacement that was itself changed or cancelled
         -- later still replaced this one. Declined / withdrawn never did.
         (SELECT c.id FROM staff_leave_requests c
           WHERE c.replaces_request_id = r.id AND c.status IN ('approved','cancelled') LIMIT 1) AS replaced_by_id
    FROM staff_leave_requests r
    JOIN people p ON p.id = r.person_id
    LEFT JOIN users du ON du.id = r.decided_by
    LEFT JOIN people dp ON dp.id = du.person_id
    LEFT JOIN staff_leave_requests o ON o.id = r.replaces_request_id`;

export async function getRequest(requestId: string): Promise<LeaveRequest | null> {
  const r = await query(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId]);
  if (r.rows.length === 0) return null;
  const days = await query(
    `SELECT leave_date::text AS leave_date, minutes, portion,
            start_time::text AS start_time, end_time::text AS end_time
       FROM staff_leave_request_days WHERE request_id = $1 ORDER BY leave_date`,
    [requestId]
  );
  return mapRequest(r.rows[0], days.rows);
}

export async function listRequests(opts: {
  personId?: string; status?: LeaveStatus; from?: string; to?: string; limit?: number;
  /** Only approved bookings with an ask to cancel waiting (the approvals list). */
  cancelAsked?: boolean;
}): Promise<LeaveRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`r.person_id = $${params.length}`); }
  if (opts.status)   { params.push(opts.status);   where.push(`r.status = $${params.length}`); }
  if (opts.from)     { params.push(opts.from);     where.push(`r.end_date >= $${params.length}::date`); }
  if (opts.to)       { params.push(opts.to);       where.push(`r.start_date <= $${params.length}::date`); }
  if (opts.cancelAsked) {
    where.push(`r.status = 'approved' AND r.cancel_requested_at IS NOT NULL AND r.cancel_declined_at IS NULL`);
  }
  params.push(Math.min(opts.limit ?? 100, 500));

  const r = await query(
    `${REQUEST_SELECT}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.status = 'pending' DESC, r.start_date DESC
      LIMIT $${params.length}`,
    params
  );
  if (r.rows.length === 0) return [];

  const days = await query(
    `SELECT request_id, leave_date::text AS leave_date, minutes, portion,
            start_time::text AS start_time, end_time::text AS end_time
       FROM staff_leave_request_days
      WHERE request_id = ANY($1::uuid[])
      ORDER BY leave_date`,
    [r.rows.map((x: { id: string }) => x.id)]
  );
  return r.rows.map((row: { id: string }) =>
    mapRequest(row, days.rows.filter((d: { request_id: string }) => d.request_id === row.id)));
}

function mapRequest(row: Record<string, unknown>, days: Record<string, unknown>[]): LeaveRequest {
  return {
    id: row.id as string,
    personId: row.person_id as string,
    personName: row.person_name as string,
    leaveType: row.leave_type as LeaveType,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    totalMinutes: Number(row.total_minutes),
    status: row.status as LeaveStatus,
    requestNote: (row.request_note as string) ?? null,
    requestedAt: new Date(row.requested_at as string).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
    decidedByName: (row.decided_by_name as string) ?? null,
    decisionNote: (row.decision_note as string) ?? null,
    cancellationReason: (row.cancellation_reason as string) ?? null,
    days: days.map(d => ({
      date: d.leave_date as string,
      minutes: Number(d.minutes),
      portion: d.portion as DayPortion,
      startTime: (d.start_time as string) ?? null,
      endTime: (d.end_time as string) ?? null,
    })),
    replacesRequestId: (row.replaces_request_id as string) ?? null,
    replaces: row.replaces_request_id && row.replaces_start_date
      ? {
          startDate: row.replaces_start_date as string,
          endDate: row.replaces_end_date as string,
          totalMinutes: Number(row.replaces_total_minutes),
          leaveType: row.replaces_leave_type as LeaveType,
          status: row.replaces_status as LeaveStatus,
        }
      : null,
    pendingChangeId: (row.pending_change_id as string) ?? null,
    replacedById: (row.replaced_by_id as string) ?? null,
    cancelAsk: row.cancel_requested_at
      ? {
          requestedAt: new Date(row.cancel_requested_at as string).toISOString(),
          note: (row.cancel_request_note as string) ?? null,
          declinedAt: row.cancel_declined_at ? new Date(row.cancel_declined_at as string).toISOString() : null,
          declineNote: (row.cancel_decline_note as string) ?? null,
        }
      : null,
  };
}

/** Count of requests awaiting a decision — drives the nav badge. Asks to cancel count too. */
export async function countPending(): Promise<number> {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM staff_leave_requests
      WHERE status = 'pending'
         OR (status = 'approved' AND cancel_requested_at IS NOT NULL AND cancel_declined_at IS NULL)`);
  return r.rows[0].n as number;
}
