/**
 * Leave requests — book, approve, decline, cancel (Staff Calendar, Phase B2).
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

/** What the caller asks for on a given date: a whole day, a half, or a period. */
export interface DaySpec {
  portion: DayPortion;
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
  for (const day of person.days) {
    if (day.status !== 'working' || day.scheduledMinutes <= 0) continue;

    const raw = dayOverrides[day.date];
    const spec: DaySpec = typeof raw === 'string' ? { portion: raw } : (raw ?? { portion: 'full' });

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
  return out;
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
}

/**
 * What would happen if this were approved.
 *
 * Shown to the REQUESTER before they submit as well as to the approver — the
 * best clash is the one that never gets requested. Every finding is a warning.
 */
export async function getImpact(
  personId: string, startDate: string, endDate: string, leaveType: LeaveType,
  dayOverrides: Record<string, DaySpec | DayPortion> = {}, excludeRequestId?: string
): Promise<LeaveImpact> {
  const days = await buildDays(personId, startDate, endDate, dayOverrides);
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);
  const account = accountFor(leaveType);

  // PER LEAVE YEAR, because a request can straddle 31 December and the ledger
  // already does: approveRequest posts one debit per day into that day's own
  // leave year. Pricing the whole request against the START year — which this
  // did — meant a 28 Dec–4 Jan request was checked entirely against December's
  // balance and then quietly put January's into deficit on approval. The
  // preview and the ledger disagreed, which is the failure mode this codebase
  // is most prone to.
  const minutesByYear = new Map<number, number>();
  for (const d of days) {
    const y = Number(d.date.slice(0, 4));
    minutesByYear.set(y, (minutesByYear.get(y) ?? 0) + d.minutes);
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
      perYear.push({
        year: y, minutes: mins,
        balanceBefore: bal.balanceMinutes, balanceAfter: after,
        shortfallMinutes: after < 0 ? -after : 0,
      });
      if (after < 0) shortfallMinutes += -after;
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

  const today = new Date().toISOString().slice(0, 10);
  const noticeDays = Math.max(0, dateRange(today, startDate).length - 1);

  // Everyone else's live leave over the same dates.
  const dateList = days.map(d => d.date);
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
    const team = await getStaffCalendar(dateList[0], dateList[dateList.length - 1], { isAdmin: true });
    for (const date of dateList) {
      const scheduled = team.filter(t => t.days.find(x => x.date === date)?.status === 'working').length;
      coverage.push({ date, scheduled, ifApproved: Math.max(0, scheduled - 1) });
    }
  }

  // The person's OWN live leave over these dates. The unique index refuses the
  // booking outright, so this exists to say so BEFORE they submit rather than
  // after — the same fact, delivered early.
  let ownClashes: string[] = [];
  if (dateList.length > 0) {
    const own = await query(
      `SELECT d.leave_date::text AS leave_date
         FROM staff_leave_request_days d
         JOIN staff_leave_requests r ON r.id = d.request_id
        WHERE d.is_live AND d.person_id = $1
          AND d.leave_date = ANY($2::date[])
          AND ($3::uuid IS NULL OR r.id <> $3::uuid)
        ORDER BY d.leave_date`,
      [personId, dateList, excludeRequestId ?? null]
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
    warnings.push('None of those dates are days this person is contracted to work.');
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
  if (noticeDays < noticeThreshold && days.length > 0) {
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
}, userId: string): Promise<string> {
  const days = await buildDays(input.personId, input.startDate, input.endDate, input.halfDays ?? {});
  if (days.length === 0) {
    throw new Error('None of those dates are days this person is contracted to work');
  }
  const totalMinutes = days.reduce((s, d) => s + d.minutes, 0);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO staff_leave_requests
         (person_id, leave_type, start_date, end_date, total_minutes, request_note, requested_by)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7)
       RETURNING id`,
      [input.personId, input.leaveType, input.startDate, input.endDate,
       totalMinutes, input.note ?? null, userId]
    );
    const id = r.rows[0].id as string;

    for (const d of days) {
      await client.query(
        `INSERT INTO staff_leave_request_days
           (request_id, person_id, leave_date, minutes, portion, start_time, end_time, is_live)
         VALUES ($1,$2,$3::date,$4,$5,$6::time,$7::time,true)`,
        [id, input.personId, d.date, d.minutes, d.portion, d.startTime ?? null, d.endTime ?? null]
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
    throw err;
  } finally {
    client.release();
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

  const account = accountFor(req.leaveType);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE staff_leave_requests
          SET status='approved', decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
        WHERE id=$1 AND status='pending'`,
      [requestId, userId, note]
    );

    if (account) {
      // The debit type is PER ACCOUNT: spending the overtime bank on a day off
      // is 'spend_toil', not 'booking' (which is holiday-only). Migration 208's
      // per-account constraint refuses the wrong one outright — which is how
      // this was caught, having shipped broken in B2.
      const debitType = account === 'overtime' ? 'spend_toil' : 'booking';
      // One debit per day, so the ledger reads as the days actually taken and
      // a later single-day reclaim (sickness during holiday) has something to
      // reverse. effective_date is the day off, not the day approved.
      for (const d of req.days) {
        await client.query(
          `INSERT INTO staff_ledger_entries
             (person_id, account, leave_year, entry_type, minutes, effective_date,
              source_type, source_id, note, created_by)
           VALUES ($1,$2,$3,$9,$4,$5::date,'leave_request',$6,$7,$8)`,
          [req.personId, account, Number(d.date.slice(0, 4)), -d.minutes, d.date,
           requestId, `${req.leaveType} — ${d.portion === 'full' ? 'full day' : d.portion}`,
           userId, debitType]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

  const account = accountFor(req.leaveType);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE staff_leave_requests
          SET status='cancelled', cancelled_by=$2, cancelled_at=NOW(),
              cancellation_reason=$3, updated_at=NOW()
        WHERE id=$1 AND status='approved'`,
      [requestId, userId, reason]
    );
    if (account) {
      for (const d of req.days) {
        await client.query(
          `INSERT INTO staff_ledger_entries
             (person_id, account, leave_year, entry_type, minutes, effective_date,
              source_type, source_id, note, created_by)
           VALUES ($1,$2,$3,'cancellation',$4,$5::date,'leave_request',$6,$7,$8)`,
          [req.personId, account, Number(d.date.slice(0, 4)), d.minutes, d.date,
           requestId, `Cancelled: ${reason}`, userId]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getRequest(requestId: string): Promise<LeaveRequest | null> {
  const r = await query(
    `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date,
            (p.first_name || ' ' || p.last_name) AS person_name,
            (dp.first_name || ' ' || dp.last_name) AS decided_by_name
       FROM staff_leave_requests r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN users du ON du.id = r.decided_by
       LEFT JOIN people dp ON dp.id = du.person_id
      WHERE r.id = $1`,
    [requestId]
  );
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
}): Promise<LeaveRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`r.person_id = $${params.length}`); }
  if (opts.status)   { params.push(opts.status);   where.push(`r.status = $${params.length}`); }
  if (opts.from)     { params.push(opts.from);     where.push(`r.end_date >= $${params.length}::date`); }
  if (opts.to)       { params.push(opts.to);       where.push(`r.start_date <= $${params.length}::date`); }
  params.push(Math.min(opts.limit ?? 100, 500));

  const r = await query(
    `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date,
            (p.first_name || ' ' || p.last_name) AS person_name,
            (dp.first_name || ' ' || dp.last_name) AS decided_by_name
       FROM staff_leave_requests r
       JOIN people p ON p.id = r.person_id
       LEFT JOIN users du ON du.id = r.decided_by
       LEFT JOIN people dp ON dp.id = du.person_id
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
  };
}

/** Count of requests awaiting a decision — drives the nav badge. */
export async function countPending(): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM staff_leave_requests WHERE status = 'pending'`);
  return r.rows[0].n as number;
}
