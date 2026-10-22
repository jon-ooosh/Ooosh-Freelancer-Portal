/**
 * Swapping a day — THE definition (staff calendar spec §8.2, built Oct 2026).
 *
 * "I usually work Saturday — can I work the Friday instead and have the
 * Saturday off?" Asked for on My Time and approved like holiday (same
 * approvers, same emails, the same "Waiting for you" panel). It touches no
 * balance: it moves WHICH day is contracted, nothing more.
 *
 * STORAGE: two staff_pattern_exceptions rows sharing a swap_group_id — the day
 * OFF (is_working = false) and the day IN (is_working = true, with times). The
 * group id IS the swap's id everywhere: routes, bells, emails. Both legs always
 * move together — approve, decline, withdraw and call off act on the group,
 * never on one leg.
 *
 * NOTHING SHOWS UNTIL IT IS APPROVED (jon, Oct 2026). staff-day-status.ts reads
 * approved exceptions only, so a waiting swap changes no calendar, no headcount
 * and no "can I book this day?" answer.
 *
 * THE DAY IN: start and finish are the person's choice, pre-filled from the day
 * given up (jon, Oct 2026 — a Friday and a Saturday do not always run the same
 * hours). The unpaid break is copied from the day given up and not asked for:
 * My Time does not show breaks (jon, Oct 2026). The paid minutes of the day
 * given up are snapshotted on the request (`usual_minutes`) so the approver
 * sees any difference, and a later hours change cannot rewrite it.
 *
 * TWO PEOPLE SWAPPING is two of these, one each, approved by somebody who
 * knows they belong together (jon, Oct 2026). Nothing links them.
 */

import { query, getClient } from '../config/database';
import { DATE_RE, getStaffCalendar, shiftMinutes, type StaffDay } from './staff-day-status';
import { getCompanyDayOverlay } from './staff-company-days';
import { ukToday } from './uk-date';
import { retireSwapRequestBells } from './staff-notifications';

export type SwapStatus = 'pending' | 'approved' | 'declined' | 'withdrawn' | 'cancelled';

export interface DaySwap {
  /** The swap_group_id — the swap's id everywhere. */
  id: string;
  personId: string;
  personName: string;
  /** The day they normally work and will have off. */
  offDate: string;
  /** The day they normally do not work and will work instead. */
  workDate: string;
  startTime: string;
  endTime: string;
  /** Paid minutes on the day in. */
  minutes: number;
  /** Paid minutes the day given up was worth when asked. NULL on older rows. */
  usualMinutes: number | null;
  status: SwapStatus;
  requestNote: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

// ── The rules (pure — exported for tests) ───────────────────────────────────

/**
 * Why a swap of these two days cannot be recorded. Empty = it can.
 *
 * These REFUSE rather than warn, because each would leave the calendar
 * disagreeing with itself or with the ledger — the same level as leave's
 * "not a day you are contracted to work". Whether it suits the business is a
 * judgement for the approver, and nothing here makes it.
 *
 * `off` / `work` are the days as the calendar resolves them WITH leave,
 * absence and company days applied (approved changes only — a waiting request
 * changes nothing). Either may be left out while the form is half filled in.
 * Wording is neutral so the same sentence reads right to the person asking and
 * to the admin approving.
 */
export function swapProblems(input: {
  offDate?: string | null;
  workDate?: string | null;
  off?: StaffDay;
  work?: StaffDay;
  /** Of the two dates, those already in another live (waiting or approved) change. */
  takenDates?: string[];
  /** Set when the company is shut on the day in (spec §20). */
  workCompanyDay?: string | null;
}): string[] {
  const { offDate, workDate, off, work } = input;
  const taken = new Set(input.takenDates ?? []);
  const problems: string[] = [];

  if (offDate && workDate && offDate === workDate) {
    return ['Pick two different days — the day off and the day worked instead'];
  }
  // Not employed, or no such person: nothing else is worth saying.
  if ((offDate && !off) || (workDate && !work)) return ['There is no staff record for this person'];

  if (offDate && off) {
    if (taken.has(offDate)) {
      problems.push(`${fmtDate(offDate)} is already part of another change to the working days`);
    } else if (off.companyDay) {
      problems.push(`The office is shut on ${fmtDate(offDate)} (${off.companyDay}), so there is nothing to swap`);
    } else if (off.status === 'not_scheduled') {
      problems.push(`${fmtDate(offDate)} isn't a normal working day — pick a day that is`);
    } else if (off.status === 'absent' || off.detail?.absenceType) {
      problems.push(`${fmtDate(offDate)} is already recorded as a day off`);
    } else if (off.status !== 'working' || off.pending) {
      problems.push(`${fmtDate(offDate)} already has time off booked or requested — withdraw that first`);
    }
  }

  if (workDate && work) {
    if (taken.has(workDate)) {
      problems.push(`${fmtDate(workDate)} is already part of another change to the working days`);
    } else if (input.workCompanyDay) {
      problems.push(`The office is shut on ${fmtDate(workDate)} (${input.workCompanyDay})`);
    } else if (work.status !== 'not_scheduled') {
      problems.push(`${fmtDate(workDate)} is already a working day — pick a day that normally isn't`);
    }
  }

  return problems;
}

/**
 * The unpaid break on a working day, recovered from its times and paid
 * minutes: a pattern day's minutes are end − start − break by construction
 * (normalisePatternDay), so the difference IS the break.
 */
export function breakOf(day: StaffDay | undefined): number {
  if (!day || day.status !== 'working' || !day.startTime || !day.endTime) return 0;
  return Math.max(0, shiftMinutes(day.startTime, day.endTime, 0) - day.scheduledMinutes);
}

// ── Checking against the database ───────────────────────────────────────────

export interface SwapCheck {
  problems: string[];
  /** The day given up as it normally runs — what the form pre-fills from. */
  usual: { startTime: string; endTime: string; minutes: number; breakMinutes: number } | null;
}

/**
 * Run swapProblems() against the real calendar. `excludeSwapId` leaves a
 * swap's OWN rows out of the "already part of another change" test, so
 * approving re-checks a request without tripping over itself.
 */
export async function checkSwap(
  personId: string, offDate: string | null, workDate: string | null, excludeSwapId?: string
): Promise<SwapCheck> {
  for (const d of [offDate, workDate]) {
    if (d && !DATE_RE.test(d)) throw new Error('Dates must be YYYY-MM-DD');
  }
  const dayOf = async (date: string | null) => {
    if (!date) return undefined;
    const [p] = await getStaffCalendar(date, date, { isAdmin: true, personId });
    return p?.days[0];
  };
  const [off, work] = await Promise.all([dayOf(offDate), dayOf(workDate)]);

  let workCompanyDay: string | null = null;
  if (workDate) {
    workCompanyDay = (await getCompanyDayOverlay(workDate, workDate)).get(workDate)?.label ?? null;
  }

  const dates = [offDate, workDate].filter((d): d is string => !!d);
  let takenDates: string[] = [];
  if (dates.length) {
    const r = await query(
      `SELECT exception_date::text AS d
         FROM staff_pattern_exceptions
        WHERE person_id = $1
          AND exception_date = ANY($2::date[])
          AND status IN ('pending','approved')
          AND ($3::uuid IS NULL OR swap_group_id IS DISTINCT FROM $3::uuid)`,
      [personId, dates, excludeSwapId ?? null]);
    takenDates = r.rows.map(row => row.d as string);
  }

  const problems = swapProblems({ offDate, workDate, off, work, takenDates, workCompanyDay });
  const usual = off && off.status === 'working' && off.startTime && off.endTime
    ? {
        startTime: off.startTime.slice(0, 5),
        endTime: off.endTime.slice(0, 5),
        minutes: off.scheduledMinutes,
        breakMinutes: breakOf(off),
      }
    : null;
  return { problems, usual };
}

// ── Asking, deciding, taking back ───────────────────────────────────────────

export async function createSwapRequest(input: {
  personId: string; offDate: string; workDate: string;
  startTime: string; endTime: string; note?: string | null;
}, userId: string): Promise<string> {
  const { personId, offDate, workDate } = input;
  if (!DATE_RE.test(offDate) || !DATE_RE.test(workDate)) throw new Error('Dates must be YYYY-MM-DD');

  const check = await checkSwap(personId, offDate, workDate);
  if (check.problems.length) throw new Error(check.problems[0]);
  // Unreachable while swapProblems requires a working day off, but the insert
  // below must never be handed a missing break.
  if (!check.usual) throw new Error(`${fmtDate(offDate)} isn't a normal working day — pick a day that is`);

  const startTime = input.startTime.slice(0, 5);
  const endTime = input.endTime.slice(0, 5);
  const breakMinutes = check.usual.breakMinutes;
  const minutes = shiftMinutes(startTime, endTime, breakMinutes);
  if (shiftMinutes(startTime, endTime, 0) <= 0) throw new Error('The finish time needs to be after the start');
  if (minutes <= 0) {
    throw new Error(`${startTime}–${endTime} leaves no working time after the usual ${breakMinutes}-minute break`);
  }
  const note = input.note?.trim() || null;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const g = await client.query('SELECT gen_random_uuid() AS id');
    const swapId = g.rows[0].id as string;
    // The day off: shape CHECK requires no times and zero minutes.
    await client.query(
      `INSERT INTO staff_pattern_exceptions
         (person_id, exception_date, is_working, start_time, end_time, break_minutes, minutes,
          reason, swap_group_id, status, requested_by, usual_minutes)
       VALUES ($1, $2::date, false, NULL, NULL, 0, 0, $3, $4, 'pending', $5, $6)`,
      [personId, offDate, note, swapId, userId, check.usual.minutes]);
    // The day in.
    await client.query(
      `INSERT INTO staff_pattern_exceptions
         (person_id, exception_date, is_working, start_time, end_time, break_minutes, minutes,
          reason, swap_group_id, status, requested_by, usual_minutes)
       VALUES ($1, $2::date, true, $3::time, $4::time, $5, $6, $7, $8, 'pending', $9, 0)`,
      [personId, workDate, startTime, endTime, breakMinutes, minutes, note, swapId, userId]);
    await client.query('COMMIT');
    return swapId;
  } catch (err) {
    await client.query('ROLLBACK');
    // The unique index on (person, date) for live rows — a request racing
    // another one for the same day. Say it the way the check above does.
    if ((err as { code?: string }).code === '23505') {
      throw new Error('One of those days is already part of another change to the working days');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * pending → approved | declined. Admin only (the route says so).
 *
 * Approving RE-CHECKS both days first. A swap can wait a while, and in that
 * time holiday may have been booked on the day being given up — approving
 * then would leave a paid-for leave day on a date the calendar no longer
 * calls a working day.
 */
export async function decideSwap(
  swapId: string, outcome: 'approved' | 'declined', note: string | null, userId: string
): Promise<DaySwap> {
  const swap = await getSwap(swapId);
  if (!swap || swap.status !== 'pending') throw new Error('That swap is no longer waiting for a decision');

  if (outcome === 'approved') {
    const check = await checkSwap(swap.personId, swap.offDate, swap.workDate, swapId);
    if (check.problems.length) {
      throw new Error(`This swap can't be approved as it stands: ${check.problems[0]}`);
    }
  }

  // approved_by / approved_at are 206's columns and mean "approved" — set
  // only on approval. Resolved here, not with a CASE on the status parameter:
  // one pg parameter in two type contexts is a 42P08 (CLAUDE.md).
  const approvedBy = outcome === 'approved' ? userId : null;
  const r = await query(
    `UPDATE staff_pattern_exceptions
        SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4,
            approved_by = $5::uuid,
            approved_at = CASE WHEN $5::uuid IS NULL THEN NULL ELSE NOW() END,
            updated_at = NOW()
      WHERE swap_group_id = $1 AND status = 'pending'
      RETURNING id`,
    [swapId, outcome, userId, note, approvedBy]);
  if (!r.rows.length) throw new Error('That swap is no longer waiting for a decision');
  // No longer waiting — every approver's bell for it is done with.
  await retireSwapRequestBells(swapId);
  return (await getSwap(swapId))!;
}

/** The person takes back their own swap while it is still waiting. */
export async function withdrawSwap(swapId: string, personId: string): Promise<void> {
  const r = await query(
    `UPDATE staff_pattern_exceptions SET status = 'withdrawn', updated_at = NOW()
      WHERE swap_group_id = $1 AND person_id = $2 AND status = 'pending' RETURNING id`,
    [swapId, personId]);
  if (!r.rows.length) throw new Error('That swap is no longer waiting');
  await retireSwapRequestBells(swapId);
}

/**
 * An admin calls off an approved swap — both days go back to the pattern.
 * Refused once both days have passed: by then it is a record of what
 * happened, and calling it off would rewrite the calendar's history.
 */
export async function cancelSwap(swapId: string, reason: string, userId: string): Promise<DaySwap> {
  const swap = await getSwap(swapId);
  if (!swap || swap.status !== 'approved') throw new Error('Only an approved swap can be called off');
  const today = ukToday();
  if (swap.offDate < today && swap.workDate < today) {
    throw new Error('Both days have already happened, so there is nothing to call off');
  }
  const r = await query(
    `UPDATE staff_pattern_exceptions
        SET status = 'cancelled', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW()
      WHERE swap_group_id = $1 AND status = 'approved' RETURNING id`,
    [swapId, userId, reason]);
  if (!r.rows.length) throw new Error('Only an approved swap can be called off');
  return (await getSwap(swapId))!;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * One row per swap: the day-off leg joined to the day-in leg of the same
 * group and person. An admin-made swap through POST /exceptions has the same
 * shape and is listed too (its decider is in approved_by); a one-leg change
 * has no group and is not a swap.
 */
const SELECT = `
  SELECT o.swap_group_id AS id, o.person_id,
         o.exception_date::text AS off_date, w.exception_date::text AS work_date,
         w.start_time::text AS start_time, w.end_time::text AS end_time,
         w.minutes, o.usual_minutes, w.status, w.reason AS request_note, w.created_at AS requested_at,
         COALESCE(w.decided_at, w.approved_at) AS decided_at, w.decision_note,
         (p.first_name || ' ' || p.last_name) AS person_name,
         (dp.first_name || ' ' || dp.last_name) AS decided_by_name
    FROM staff_pattern_exceptions o
    JOIN staff_pattern_exceptions w
      ON w.swap_group_id = o.swap_group_id AND w.person_id = o.person_id AND w.is_working = true
    JOIN people p ON p.id = o.person_id
    LEFT JOIN users du ON du.id = COALESCE(w.decided_by, w.approved_by)
    LEFT JOIN people dp ON dp.id = du.person_id
   WHERE o.is_working = false AND o.swap_group_id IS NOT NULL`;

function map(row: Record<string, unknown>): DaySwap {
  return {
    id: row.id as string,
    personId: row.person_id as string,
    personName: row.person_name as string,
    offDate: row.off_date as string,
    workDate: row.work_date as string,
    startTime: String(row.start_time ?? '').slice(0, 5),
    endTime: String(row.end_time ?? '').slice(0, 5),
    minutes: Number(row.minutes),
    usualMinutes: row.usual_minutes === null || row.usual_minutes === undefined ? null : Number(row.usual_minutes),
    status: row.status as SwapStatus,
    requestNote: (row.request_note as string | null) ?? null,
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decidedByName: (row.decided_by_name as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
  };
}

export async function getSwap(swapId: string): Promise<DaySwap | null> {
  const r = await query(`${SELECT} AND o.swap_group_id = $1 LIMIT 1`, [swapId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function listSwaps(opts: {
  personId?: string; status?: SwapStatus; from?: string; to?: string;
}): Promise<DaySwap[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`o.person_id = $${params.length}`); }
  if (opts.status)   { params.push(opts.status);   where.push(`w.status = $${params.length}`); }
  if (opts.from) {
    params.push(opts.from);
    where.push(`GREATEST(o.exception_date, w.exception_date) >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`LEAST(o.exception_date, w.exception_date) <= $${params.length}::date`);
  }
  const r = await query(
    `${SELECT} ${where.map(w => `AND ${w}`).join(' ')}
      ORDER BY w.status = 'pending' DESC, LEAST(o.exception_date, w.exception_date) DESC LIMIT 300`,
    params);
  return r.rows.map(map);
}
