/**
 * Staff absence — sickness, parental leave, appointments (spec §3.7, §7).
 *
 * WHAT THIS MODULE OWNS
 *
 *   - the absence spell and its day rows
 *   - materialising days for an OPEN absence as it runs
 *   - the return-to-work record and its one chase
 *   - reclaiming holiday that was overtaken by sickness (§7.4)
 *   - absence reporting by SPELL, which is the number that means something
 *
 * WHAT IT DOES NOT OWN
 *
 *   - the balance. Any ledger write goes through staff-balance.ts postEntry();
 *     this module never SUMs staff_ledger_entries (see the rule file).
 *   - the calendar. getAbsenceOverlay() hands rows to staff-day-status.ts,
 *     which is the only thing that decides what a day looks like.
 *   - masking. maskForViewer() in staff-day-status.ts strips the type; nothing
 *     here should be handing an absence type to a non-admin caller.
 *
 * OPEN ABSENCES AND LAZY CATCH-UP
 *
 * An open sickness has no end date, so its day rows cannot all be written up
 * front. Rather than a nightly job — which is exactly the kind of thing that
 * stops silently and is noticed in March — materialiseDays() is idempotent
 * (ON CONFLICT DO NOTHING) and is called on every read and every write. The
 * read repairs the data, so it cannot drift.
 *
 * DATES: 'YYYY-MM-DD' strings throughout, UTC, selected as ::text. Same rule
 * as staff-day-status.ts and for the same reason — a JS Date at local midnight
 * drifts a day under BST.
 */

import { query, getClient } from '../config/database';
import {
  DATE_RE, addDaysYmd, dateRange, getStaffCalendar, type DayPortion,
} from './staff-day-status';
import { postEntry } from './staff-balance';
import { minutesBetweenTimes } from './staff-leave';

export type AbsenceType =
  | 'sickness' | 'maternity' | 'paternity' | 'shared_parental' | 'adoption'
  | 'bereavement' | 'compassionate' | 'goodwill' | 'jury_service'
  | 'medical_appointment' | 'other';

export const ABSENCE_TYPES: AbsenceType[] = [
  'sickness', 'maternity', 'paternity', 'shared_parental', 'adoption',
  'bereavement', 'compassionate', 'goodwill', 'jury_service',
  'medical_appointment', 'other',
];

/**
 * The only types staff may record for themselves (spec §7.5).
 *
 * Everything else is admin-entered, because it is either special-category or
 * it costs allowance. These two are neither: a timed marker is a presence
 * flag, and its whole point is that the person out at 2 can record it without
 * going through anyone.
 */
export const SELF_SERVICE_TYPES: AbsenceType[] = ['medical_appointment', 'other'];

export type FitToReturn = 'yes' | 'yes_with_adjustments' | 'no';

export interface AbsenceDay {
  date: string;
  minutes: number;
  portion: DayPortion;
  startTime: string | null;
  endTime: string | null;
}

export interface Absence {
  id: string;
  personId: string;
  personName: string;
  absenceType: AbsenceType;
  startDate: string;
  endDate: string | null;
  isOpen: boolean;
  status: 'active' | 'cancelled';
  deductsAllowance: boolean;
  totalMinutes: number | null;
  workingDays: number | null;
  /** ADMIN ONLY — the route strips this for anyone else. */
  reasonCategory: string | null;
  notes: string | null;
  selfCertified: boolean;
  fitNoteReceived: boolean;
  fitNoteExpiry: string | null;
  sspQualifying: boolean | null;
  rtwRequired: boolean;
  rtwDate: string | null;
  rtwCompletedAt: string | null;
  rtwByName: string | null;
  rtwFitToReturn: FitToReturn | null;
  rtwAdjustments: string | null;
  rtwNotes: string | null;
  cancellationReason: string | null;
  createdAt: string;
  days: AbsenceDay[];
}

const TODAY = () => new Date().toISOString().slice(0, 10);

// ── Building the days ───────────────────────────────────────────────────────

/**
 * Turn a date range into the days an absence actually covers.
 *
 * Mirrors buildDays() in staff-leave.ts exactly, and for the same reason:
 * non-working days produce NO ROW, so a sickness over a weekend does not
 * invent two days of sickness and no weekend-skipping logic ends up scattered
 * around the codebase.
 *
 * The calendar is read RAW — includeLeave / includeAbsence false. Pricing
 * against an overlaid calendar is the bug that shipped in B2: days already
 * spoken for silently vanish instead of surfacing as the clash they are.
 */
export async function buildAbsenceDays(
  personId: string,
  startDate: string,
  endDate: string,
  portion: DayPortion = 'full',
  startTime?: string,
  endTime?: string
): Promise<AbsenceDay[]> {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) throw new Error('Dates must be YYYY-MM-DD');
  if (endDate < startDate) throw new Error('The end date must be on or after the start date');
  if (dateRange(startDate, endDate).length > 366) {
    throw new Error('A single absence cannot span more than a year');
  }

  const [person] = await getStaffCalendar(startDate, endDate, {
    isAdmin: true, personId, includeLeave: false, includeAbsence: false,
  });
  if (!person) throw new Error('No staff record for this person');

  const out: AbsenceDay[] = [];
  for (const day of person.days) {
    if (day.status !== 'working' || day.scheduledMinutes <= 0) continue;

    if (portion === 'hours') {
      if (!startTime || !endTime) throw new Error('A timed absence needs both a start and an end time');
      const minutes = minutesBetweenTimes(startTime, endTime);
      if (minutes <= 0) throw new Error('The end time must be after the start time');
      if (minutes > day.scheduledMinutes) {
        throw new Error(
          `That period is longer than the ${Math.round(day.scheduledMinutes / 60 * 10) / 10}h they are contracted to work on ${day.date}`
        );
      }
      out.push({ date: day.date, minutes, portion, startTime, endTime });
      continue;
    }

    const minutes = portion === 'full' ? day.scheduledMinutes : Math.round(day.scheduledMinutes / 2);
    out.push({ date: day.date, minutes, portion, startTime: null, endTime: null });
  }
  return out;
}

/**
 * Bring an absence's day rows up to date. Idempotent, and safe to call often.
 *
 * For a CLOSED absence this fills the whole span once. For an OPEN one it fills
 * up to `upTo` (today, normally) and will fill tomorrow's row tomorrow — which
 * is how an open sickness keeps showing on the calendar without a nightly job.
 *
 * Returns the number of rows it added, so callers can tell whether anything
 * changed without re-reading.
 */
export async function materialiseDays(absenceId: string, upTo: string = TODAY()): Promise<number> {
  const r = await query(
    `SELECT person_id, start_date::text AS start_date, end_date::text AS end_date,
            status,
            (SELECT portion    FROM staff_absence_days WHERE absence_id = a.id LIMIT 1) AS portion,
            (SELECT start_time::text FROM staff_absence_days WHERE absence_id = a.id LIMIT 1) AS start_time,
            (SELECT end_time::text   FROM staff_absence_days WHERE absence_id = a.id LIMIT 1) AS end_time
       FROM staff_absences a WHERE a.id = $1`,
    [absenceId]
  );
  const a = r.rows[0];
  if (!a || a.status !== 'active') return 0;

  // An open absence is only ever materialised as far as `upTo` (today). A spell
  // that has not started yet has nothing to write — NOT its first day, which
  // is what clamping up to start_date would have done.
  const end: string = a.end_date ?? upTo;
  if (end < a.start_date) return 0;

  const portion = (a.portion as DayPortion) ?? 'full';
  const days = await buildAbsenceDays(
    a.person_id, a.start_date, end, portion,
    a.start_time ? String(a.start_time).slice(0, 5) : undefined,
    a.end_time ? String(a.end_time).slice(0, 5) : undefined
  );
  if (days.length === 0) return 0;

  let added = 0;
  for (const d of days) {
    const ins = await query(
      `INSERT INTO staff_absence_days
         (absence_id, person_id, absence_date, minutes, portion, start_time, end_time)
       VALUES ($1,$2,$3::date,$4,$5,$6::time,$7::time)
       ON CONFLICT (absence_id, absence_date) DO NOTHING
       RETURNING id`,
      [absenceId, a.person_id, d.date, d.minutes, d.portion, d.startTime, d.endTime]
    );
    added += ins.rows.length;
  }
  return added;
}

/** Catch every open absence up to today. Called on any absence or calendar read. */
export async function materialiseOpenAbsences(personIds?: string[]): Promise<void> {
  const r = await query(
    `SELECT id FROM staff_absences
      WHERE is_open AND status = 'active'
        AND ($1::uuid[] IS NULL OR person_id = ANY($1::uuid[]))`,
    [personIds && personIds.length > 0 ? personIds : null]
  );
  for (const row of r.rows) {
    await materialiseDays(row.id).catch(e =>
      console.error(`[staff-absence] catch-up failed for ${row.id}:`, e));
  }
}

// ── The calendar overlay ────────────────────────────────────────────────────
//
// getAbsenceOverlay() lives in staff-day-status.ts, NOT here — the same place
// getLeaveOverlay() lives, and for the same reason. This module reads the
// calendar (buildAbsenceDays), so if the calendar also statically imported
// this module the two would be a cycle. Day-status owns the overlays; the
// feature modules own everything else.

// ── Create / close / cancel ─────────────────────────────────────────────────

export interface CreateAbsenceInput {
  personId: string;
  absenceType: AbsenceType;
  startDate: string;
  /** Omit for an absence that is still running. */
  endDate?: string | null;
  portion?: DayPortion;
  startTime?: string;
  endTime?: string;
  deductsAllowance?: boolean;
  reasonCategory?: string | null;
  notes?: string | null;
  selfCertified?: boolean;
  fitNoteReceived?: boolean;
  fitNoteExpiry?: string | null;
  sspQualifying?: boolean | null;
  rtwRequired?: boolean;
}

/**
 * Open an absence and materialise its days.
 *
 * ONE TRANSACTION, because a header with no day rows is an absence that does
 * not appear on the calendar — which is worse than a failed write, since
 * nothing tells you it happened.
 */
export async function createAbsence(input: CreateAbsenceInput, userId: string | null): Promise<Absence> {
  const portion: DayPortion = input.portion ?? 'full';
  if (portion === 'hours') {
    if (!input.startTime || !input.endTime) throw new Error('A timed absence needs both a start and an end time');
    // A marker is a single day by definition: "out 14:00–15:00" across a week
    // is not one absence, it is five.
    if (input.endDate && input.endDate !== input.startDate) {
      throw new Error('A timed absence covers a single day');
    }
  }

  // An OPEN absence has no day rows to read a portion back from, so the
  // catch-up assumes whole days. Rather than let that silently re-price an
  // ongoing half-day, refuse it: "off every afternoon, indefinitely" is not a
  // real arrangement, and a pattern change is the right tool if it becomes one.
  if ((input.endDate ?? null) === null && portion !== 'full' && portion !== 'hours') {
    throw new Error('An ongoing absence has to be whole days — give it an end date to record half days');
  }

  const end = portion === 'hours' ? input.startDate : (input.endDate ?? null);

  // An OPEN absence only ever materialises as far as today — writing future
  // rows would mark someone sick for days that have not happened. One that
  // STARTS in the future (booked maternity, jury service with a date) opens
  // with no day rows at all and the catch-up fills them when it begins.
  const buildTo = end ?? TODAY();
  const days = buildTo < input.startDate
    ? []
    : await buildAbsenceDays(
        input.personId, input.startDate, buildTo, portion, input.startTime, input.endTime);

  // Refusing this is kinder than storing a spell that shows up nowhere. It
  // only applies to an absence with known dates: an open one legitimately has
  // no days yet.
  if (days.length === 0 && end !== null) {
    throw new Error('None of those dates are days this person is contracted to work');
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO staff_absences
         (person_id, absence_type, start_date, end_date, is_open, deducts_allowance,
          reason_category, notes, self_certified, fit_note_received, fit_note_expiry,
          ssp_qualifying, rtw_required, created_by)
       VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14)
       RETURNING id`,
      [
        input.personId, input.absenceType, input.startDate, end, end === null,
        input.deductsAllowance ?? false,
        input.reasonCategory ?? null, input.notes ?? null,
        input.selfCertified ?? false, input.fitNoteReceived ?? false,
        input.fitNoteExpiry ?? null, input.sspQualifying ?? null,
        // Only sickness raises a return-to-work by default. A bereavement or a
        // dentist appointment does not need one, and defaulting them to true
        // would fill the chase with noise nobody then reads.
        input.rtwRequired ?? (input.absenceType === 'sickness'),
        userId,
      ]
    );
    const id: string = ins.rows[0].id;

    for (const d of days) {
      await client.query(
        `INSERT INTO staff_absence_days
           (absence_id, person_id, absence_date, minutes, portion, start_time, end_time)
         VALUES ($1,$2,$3::date,$4,$5,$6::time,$7::time)`,
        [id, input.personId, d.date, d.minutes, d.portion, d.startTime, d.endTime]
      );
    }

    await client.query('COMMIT');

    if (input.deductsAllowance) await postAbsenceDebit(id, userId);
    const created = await getAbsence(id);
    if (!created) throw new Error('Absence vanished immediately after being created');
    return created;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Debit the holiday account for an absence that deducts allowance.
 *
 * 'booking' against 'holiday', with source_type 'absence' — both already
 * permitted by migration 208's constraints. The type is the one the ledger
 * already uses for "allowance consumed"; the source is what says it was an
 * absence rather than a leave request, which is how the breakdown tells them
 * apart without a second entry type nobody would remember the rules for.
 *
 * Idempotent: it only ever posts the days not already covered, because
 * materialiseDays() keeps adding days to an open absence.
 */
async function postAbsenceDebit(absenceId: string, userId: string | null): Promise<void> {
  const r = await query(
    `SELECT a.person_id, d.absence_date::text AS absence_date, d.minutes
       FROM staff_absence_days d
       JOIN staff_absences a ON a.id = d.absence_id
      WHERE d.absence_id = $1 AND d.is_active AND a.deducts_allowance
        AND NOT EXISTS (
          SELECT 1 FROM staff_ledger_entries e
           WHERE e.source_type = 'absence' AND e.source_id = $1
             AND e.entry_type = 'booking'
             AND e.effective_date = d.absence_date
             -- A day whose debit was REVERSED (the absence was shortened, then
             -- lengthened again) has to be chargeable a second time. Matching
             -- any entry on the date would have left it covered but free.
             AND NOT EXISTS (
               SELECT 1 FROM staff_ledger_entries r WHERE r.reverses_entry_id = e.id))`,
    [absenceId]
  );
  for (const row of r.rows) {
    if (Number(row.minutes) <= 0) continue;
    await postEntry({
      personId: row.person_id,
      account: 'holiday',
      leaveYear: Number(row.absence_date.slice(0, 4)),
      entryType: 'booking',
      minutes: -Number(row.minutes),
      effectiveDate: row.absence_date,
      sourceType: 'absence',
      sourceId: absenceId,
      note: 'Absence deducted from allowance',
    }, userId);
  }
}

/**
 * Close an absence: set the end date, price the spell, raise the RTW task.
 *
 * `working_days` is days-equivalent for reporting only — the minutes are the
 * truth (§0.1). It is computed against each day's own length, because one
 * member of staff works four days of different lengths and dividing by a
 * notional 7-hour day would report the wrong number for them specifically.
 */
export async function closeAbsence(absenceId: string, endDate: string, userId: string): Promise<Absence> {
  if (!DATE_RE.test(endDate)) throw new Error('The end date must be YYYY-MM-DD');

  const cur = await query(
    `SELECT person_id, start_date::text AS start_date, status, is_open
       FROM staff_absences WHERE id = $1`, [absenceId]);
  const a = cur.rows[0];
  if (!a) throw new Error('Absence not found');
  if (a.status !== 'active') throw new Error('That absence has been cancelled');
  if (endDate < a.start_date) throw new Error('The end date must be on or after the start date');

  // Days after the closing date are removed — an open absence may have
  // materialised past where it turned out to end, and a closed one can be
  // re-closed earlier to correct a mistake.
  //
  // Anything already DEBITED for one of those days has to be given back first.
  // Deleting the day row alone would leave the ledger holding a charge for a
  // day the absence no longer covers, and the ledger is append-only, so it
  // could never be tidied up afterwards.
  const orphaned = await query(
    `SELECT id, person_id, leave_year, minutes, effective_date::text AS effective_date
       FROM staff_ledger_entries
      WHERE source_type = 'absence' AND source_id = $1
        AND effective_date > $2::date
        AND NOT EXISTS (
          SELECT 1 FROM staff_ledger_entries r WHERE r.reverses_entry_id = staff_ledger_entries.id)`,
    [absenceId, endDate]
  );
  for (const e of orphaned.rows) {
    await postEntry({
      personId: e.person_id,
      account: 'holiday',
      leaveYear: Number(e.leave_year),
      entryType: 'cancellation',
      minutes: -Number(e.minutes),
      effectiveDate: e.effective_date,
      sourceType: 'absence',
      sourceId: absenceId,
      reversesEntryId: e.id,
      note: `Absence shortened to ${endDate}`,
    }, userId);
  }

  await query(
    `DELETE FROM staff_absence_days WHERE absence_id = $1 AND absence_date > $2::date`,
    [absenceId, endDate]
  );

  // The end date is written BEFORE the catch-up runs, not after. materialiseDays
  // reads the stored end_date and stops there, so closing an absence while it
  // still said 8 December would never generate the 9th and the 10th — the days
  // then appeared on the next read, by which point they had missed their debit
  // and were covered but free.
  await query(
    `UPDATE staff_absences SET end_date = $2::date, is_open = false, updated_at = NOW()
      WHERE id = $1`,
    [absenceId, endDate]
  );
  await materialiseDays(absenceId, endDate);

  // A full day is 1.0; a half day is 0.5; a timed period is its share of that
  // day. Derived from the day's own contracted minutes, read back fresh so a
  // pattern change between opening and closing cannot skew it.
  const dayRows = await query(
    `SELECT absence_date::text AS absence_date, minutes, portion
       FROM staff_absence_days WHERE absence_id = $1 AND is_active`, [absenceId]);
  let workingDays = 0;
  let totalMinutes = 0;
  for (const d of dayRows.rows) {
    totalMinutes += Number(d.minutes);
    workingDays += d.portion === 'full' ? 1 : d.portion === 'am' || d.portion === 'pm' ? 0.5 : 0;
  }
  // Timed periods contribute their real fraction of that day's contract.
  const timed = dayRows.rows.filter(d => d.portion === 'hours');
  if (timed.length > 0) {
    const [person] = await getStaffCalendar(
      timed[0].absence_date, timed[timed.length - 1].absence_date,
      { isAdmin: true, personId: a.person_id, includeLeave: false, includeAbsence: false });
    for (const t of timed) {
      const sched = person?.days.find(x => x.date === t.absence_date)?.scheduledMinutes ?? 0;
      if (sched > 0) workingDays += Number(t.minutes) / sched;
    }
  }
  await query(
    `UPDATE staff_absences
        SET total_minutes = $2, working_days = $3, updated_at = NOW()
      WHERE id = $1`,
    [absenceId, totalMinutes, Math.round(workingDays * 100) / 100]
  );

  await postAbsenceDebit(absenceId, userId);

  const out = await getAbsence(absenceId);
  if (!out) throw new Error('Absence not found after closing');
  return out;
}

/**
 * Soft-cancel. The day rows retire with it via the trigger, and any ledger
 * debit is reversed rather than deleted (§0.4).
 */
export async function cancelAbsence(absenceId: string, reason: string, userId: string): Promise<void> {
  const cur = await query(`SELECT status FROM staff_absences WHERE id = $1`, [absenceId]);
  if (!cur.rows[0]) throw new Error('Absence not found');
  if (cur.rows[0].status === 'cancelled') throw new Error('That absence is already cancelled');

  // ONLY the debits. An absence's ledger trail also contains the CREDITS this
  // and closeAbsence() have already posted, and they are equally un-reversed —
  // sweeping those up too tried to post a negative 'cancellation', which the
  // sign constraint in migration 208 refused. It was right to.
  const debits = await query(
    `SELECT id, person_id, leave_year, minutes, effective_date::text AS effective_date
       FROM staff_ledger_entries
      WHERE source_type = 'absence' AND source_id = $1
        AND entry_type = 'booking'
        AND NOT EXISTS (SELECT 1 FROM staff_ledger_entries r WHERE r.reverses_entry_id = staff_ledger_entries.id)`,
    [absenceId]
  );
  for (const d of debits.rows) {
    await postEntry({
      personId: d.person_id,
      account: 'holiday',
      leaveYear: Number(d.leave_year),
      entryType: 'cancellation',
      minutes: -Number(d.minutes),
      effectiveDate: d.effective_date,
      sourceType: 'absence',
      sourceId: absenceId,
      reversesEntryId: d.id,
      note: `Absence cancelled — ${reason}`,
    }, userId);
  }

  await query(
    `UPDATE staff_absences
        SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(),
            cancellation_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [absenceId, userId, reason]
  );
}

// ── Return to work (spec §7.3) ──────────────────────────────────────────────

export interface RtwInput {
  rtwDate: string;
  fitToReturn: FitToReturn;
  adjustments?: string | null;
  notes?: string | null;
  fitNoteReceived?: boolean;
  fitNoteExpiry?: string | null;
}

export async function recordRtw(absenceId: string, input: RtwInput, userId: string): Promise<Absence> {
  if (!DATE_RE.test(input.rtwDate)) throw new Error('The conversation date must be YYYY-MM-DD');

  const cur = await query(
    `SELECT is_open, status FROM staff_absences WHERE id = $1`, [absenceId]);
  const a = cur.rows[0];
  if (!a) throw new Error('Absence not found');
  if (a.status !== 'active') throw new Error('That absence has been cancelled');
  if (a.is_open) throw new Error('Close the absence before recording the return-to-work conversation');

  await query(
    `UPDATE staff_absences
        SET rtw_date = $2::date, rtw_completed_at = NOW(), rtw_by = $3,
            rtw_fit_to_return = $4, rtw_adjustments = $5, rtw_notes = $6,
            fit_note_received = COALESCE($7, fit_note_received),
            fit_note_expiry   = COALESCE($8::date, fit_note_expiry),
            updated_at = NOW()
      WHERE id = $1`,
    [absenceId, input.rtwDate, userId, input.fitToReturn,
     input.adjustments ?? null, input.notes ?? null,
     input.fitNoteReceived ?? null, input.fitNoteExpiry ?? null]
  );

  const out = await getAbsence(absenceId);
  if (!out) throw new Error('Absence not found after recording the return to work');
  return out;
}

/** Closed sickness absences still waiting on a return-to-work record. */
export async function listRtwOutstanding(): Promise<
  { id: string; personId: string; personName: string; endDate: string; daysWaiting: number; chasedAt: string | null }[]
> {
  const r = await query(
    `SELECT a.id, a.person_id, a.end_date::text AS end_date, a.rtw_chased_at,
            (p.first_name || ' ' || p.last_name) AS name,
            (CURRENT_DATE - a.end_date) AS days_waiting
       FROM staff_absences a
       JOIN people p ON p.id = a.person_id
      WHERE a.status = 'active' AND a.is_open = false
        AND a.rtw_required AND a.rtw_completed_at IS NULL
      ORDER BY a.end_date`
  );
  return r.rows.map(row => ({
    id: row.id,
    personId: row.person_id,
    personName: row.name,
    endDate: row.end_date,
    daysWaiting: Number(row.days_waiting),
    chasedAt: row.rtw_chased_at ? new Date(row.rtw_chased_at).toISOString() : null,
  }));
}

/** Mark a chase as sent, so the 7-day nudge fires once and not every morning. */
export async function markRtwChased(absenceId: string): Promise<void> {
  await query(`UPDATE staff_absences SET rtw_chased_at = NOW() WHERE id = $1`, [absenceId]);
}

// ── Holiday reclaim (spec §7.4) ─────────────────────────────────────────────

export interface ReclaimCandidate {
  dayId: string;
  requestId: string;
  date: string;
  minutes: number;
  portion: DayPortion;
  leaveType: string;
}

/**
 * Approved holiday that this absence has overtaken.
 *
 * Only 'holiday' and 'toil' — unpaid leave cost nothing, so there is nothing
 * to give back. Already-reclaimed days are excluded so the prompt cannot
 * credit the same day twice.
 */
export async function getReclaimCandidates(absenceId: string): Promise<ReclaimCandidate[]> {
  const r = await query(
    `SELECT d.id, d.request_id, d.leave_date::text AS leave_date, d.minutes, d.portion,
            r.leave_type
       FROM staff_absence_days ad
       JOIN staff_absences a           ON a.id = ad.absence_id
       JOIN staff_leave_request_days d ON d.person_id = a.person_id
                                      AND d.leave_date = ad.absence_date
       JOIN staff_leave_requests r     ON r.id = d.request_id
      WHERE ad.absence_id = $1 AND ad.is_active
        AND a.status = 'active'
        AND d.is_live
        AND d.reclaimed_absence_id IS NULL
        AND r.status = 'approved'
        AND r.leave_type IN ('holiday','toil')
      ORDER BY d.leave_date`,
    [absenceId]
  );
  return r.rows.map(row => ({
    dayId: row.id,
    requestId: row.request_id,
    date: row.leave_date,
    minutes: Number(row.minutes),
    portion: row.portion as DayPortion,
    leaveType: row.leave_type,
  }));
}

/**
 * Give those days back.
 *
 * A 'correction' CREDIT per day, as §7.4 specifies, and a stamp on the leave
 * day. The original request is untouched and still reads as approved in the
 * person's history — the reclaim is its own ledger line, which is exactly what
 * you want to be able to point at if it is ever questioned.
 *
 * TOIL days go back to the overtime bank, holiday to the holiday account.
 * Sending them all to 'holiday' would quietly convert banked overtime into
 * annual leave.
 */
export async function reclaimLeaveDays(
  absenceId: string, dayIds: string[], userId: string
): Promise<{ reclaimed: number; minutes: number }> {
  if (dayIds.length === 0) return { reclaimed: 0, minutes: 0 };

  const candidates = await getReclaimCandidates(absenceId);
  const wanted = candidates.filter(c => dayIds.includes(c.dayId));
  if (wanted.length === 0) throw new Error('None of those days can be reclaimed');

  const who = await query(`SELECT person_id FROM staff_absences WHERE id = $1`, [absenceId]);
  const personId: string = who.rows[0]?.person_id;
  if (!personId) throw new Error('Absence not found');

  let minutes = 0;
  for (const c of wanted) {
    await postEntry({
      personId,
      account: c.leaveType === 'toil' ? 'overtime' : 'holiday',
      leaveYear: Number(c.date.slice(0, 4)),
      entryType: 'correction',
      minutes: c.minutes,
      effectiveDate: c.date,
      sourceType: 'absence',
      sourceId: absenceId,
      note: `Reclaimed — off sick on a booked ${c.leaveType === 'toil' ? 'TOIL' : 'holiday'} day`,
    }, userId);

    await query(
      `UPDATE staff_leave_request_days SET reclaimed_absence_id = $2 WHERE id = $1`,
      [c.dayId, absenceId]
    );
    minutes += c.minutes;
  }
  return { reclaimed: wanted.length, minutes };
}

// ── Reads ───────────────────────────────────────────────────────────────────

const ABSENCE_SELECT = `
  SELECT a.*,
         a.start_date::text      AS start_date_t,
         a.end_date::text        AS end_date_t,
         a.fit_note_expiry::text AS fit_note_expiry_t,
         a.rtw_date::text        AS rtw_date_t,
         (p.first_name || ' ' || p.last_name) AS person_name,
         (rp.first_name || ' ' || rp.last_name) AS rtw_by_name
    FROM staff_absences a
    JOIN people p       ON p.id = a.person_id
    LEFT JOIN users ru  ON ru.id = a.rtw_by
    LEFT JOIN people rp ON rp.id = ru.person_id`;

function mapAbsence(row: Record<string, any>, days: Record<string, any>[]): Absence {
  return {
    id: row.id,
    personId: row.person_id,
    personName: row.person_name,
    absenceType: row.absence_type,
    startDate: row.start_date_t,
    endDate: row.end_date_t,
    isOpen: row.is_open,
    status: row.status,
    deductsAllowance: row.deducts_allowance,
    totalMinutes: row.total_minutes === null ? null : Number(row.total_minutes),
    workingDays: row.working_days === null ? null : Number(row.working_days),
    reasonCategory: row.reason_category,
    notes: row.notes,
    selfCertified: row.self_certified,
    fitNoteReceived: row.fit_note_received,
    fitNoteExpiry: row.fit_note_expiry_t,
    sspQualifying: row.ssp_qualifying,
    rtwRequired: row.rtw_required,
    rtwDate: row.rtw_date_t,
    rtwCompletedAt: row.rtw_completed_at ? new Date(row.rtw_completed_at).toISOString() : null,
    rtwByName: row.rtw_by_name ?? null,
    rtwFitToReturn: row.rtw_fit_to_return,
    rtwAdjustments: row.rtw_adjustments,
    rtwNotes: row.rtw_notes,
    cancellationReason: row.cancellation_reason,
    createdAt: new Date(row.created_at).toISOString(),
    days: days.map(d => ({
      date: d.absence_date,
      minutes: Number(d.minutes),
      portion: d.portion,
      startTime: d.start_time ? String(d.start_time).slice(0, 5) : null,
      endTime: d.end_time ? String(d.end_time).slice(0, 5) : null,
    })),
  };
}

export async function getAbsence(absenceId: string): Promise<Absence | null> {
  await materialiseDays(absenceId).catch(() => {});
  const r = await query(`${ABSENCE_SELECT} WHERE a.id = $1`, [absenceId]);
  if (r.rows.length === 0) return null;
  const d = await query(
    `SELECT absence_date::text AS absence_date, minutes, portion,
            start_time::text AS start_time, end_time::text AS end_time
       FROM staff_absence_days WHERE absence_id = $1 AND is_active ORDER BY absence_date, start_time`,
    [absenceId]
  );
  return mapAbsence(r.rows[0], d.rows);
}

export async function listAbsences(opts: {
  personId?: string;
  from?: string;
  to?: string;
  openOnly?: boolean;
  includeCancelled?: boolean;
  limit?: number;
}): Promise<Absence[]> {
  await materialiseOpenAbsences(opts.personId ? [opts.personId] : undefined);

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.personId) { params.push(opts.personId); where.push(`a.person_id = $${params.length}`); }
  if (opts.from)     { params.push(opts.from);     where.push(`(a.end_date IS NULL OR a.end_date >= $${params.length}::date)`); }
  if (opts.to)       { params.push(opts.to);       where.push(`a.start_date <= $${params.length}::date`); }
  if (opts.openOnly) where.push(`a.is_open`);
  if (!opts.includeCancelled) where.push(`a.status = 'active'`);
  params.push(Math.min(opts.limit ?? 200, 500));

  const r = await query(
    `${ABSENCE_SELECT}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.start_date DESC
      LIMIT $${params.length}`,
    params
  );
  if (r.rows.length === 0) return [];

  const ids = r.rows.map(x => x.id);
  const d = await query(
    `SELECT absence_id, absence_date::text AS absence_date, minutes, portion,
            start_time::text AS start_time, end_time::text AS end_time
       FROM staff_absence_days WHERE absence_id = ANY($1::uuid[]) AND is_active
      ORDER BY absence_date, start_time`,
    [ids]
  );
  const byAbsence = new Map<string, Record<string, any>[]>();
  for (const row of d.rows) {
    const list = byAbsence.get(row.absence_id) ?? [];
    list.push(row);
    byAbsence.set(row.absence_id, list);
  }
  return r.rows.map(row => mapAbsence(row, byAbsence.get(row.id) ?? []));
}

// ── Reporting (spec §7.6) ───────────────────────────────────────────────────

export interface AbsenceReportRow {
  personId: string;
  personName: string;
  spells: number;
  days: number;
  minutes: number;
  /** Spells within the flag window, and whether that trips the threshold. */
  recentSpells: number;
  flagged: boolean;
  openAbsence: boolean;
  rtwOutstanding: number;
}

/**
 * Absence by SPELL, not by day.
 *
 * Five one-day absences and one five-day absence are the same number of days
 * and completely different signals — which is the whole reason §7.6 counts
 * spells. The day total is still reported, because payroll wants it.
 */
export async function getAbsenceReport(opts: {
  from: string;
  to: string;
  flagSpells?: number;
  flagMonths?: number;
  types?: AbsenceType[];
}): Promise<AbsenceReportRow[]> {
  const flagSpells = opts.flagSpells ?? 3;
  const flagMonths = opts.flagMonths ?? 3;
  const types = opts.types ?? ['sickness'];
  const flagFrom = addDaysYmd(new Date().toISOString().slice(0, 10), -Math.round(flagMonths * 30.44));

  await materialiseOpenAbsences();

  const r = await query(
    `SELECT p.id AS person_id,
            (p.first_name || ' ' || p.last_name) AS name,
            COUNT(DISTINCT a.id) FILTER (WHERE a.id IS NOT NULL)                       AS spells,
            COALESCE(SUM(d.minutes), 0)                                                AS minutes,
            COUNT(DISTINCT d.absence_date)                                             AS days,
            COUNT(DISTINCT a.id) FILTER (WHERE a.start_date >= $4::date)               AS recent_spells,
            COUNT(DISTINCT a.id) FILTER (WHERE a.is_open)                              AS open_count,
            COUNT(DISTINCT a.id) FILTER (
              WHERE a.is_open = false AND a.rtw_required AND a.rtw_completed_at IS NULL) AS rtw_outstanding
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
       LEFT JOIN staff_absences a
              ON a.person_id = p.id
             AND a.status = 'active'
             AND a.absence_type = ANY($3::varchar[])
             AND a.start_date <= $2::date
             AND (a.end_date IS NULL OR a.end_date >= $1::date)
       LEFT JOIN staff_absence_days d
              ON d.absence_id = a.id AND d.is_active
             AND d.absence_date BETWEEN $1::date AND $2::date
      WHERE se.employment_status = 'employed' AND p.is_deleted = false
      GROUP BY p.id, p.first_name, p.last_name
      ORDER BY COUNT(DISTINCT a.id) DESC, p.first_name`,
    [opts.from, opts.to, types, flagFrom]
  );

  return r.rows.map(row => ({
    personId: row.person_id,
    personName: row.name,
    spells: Number(row.spells),
    days: Number(row.days),
    minutes: Number(row.minutes),
    recentSpells: Number(row.recent_spells),
    flagged: Number(row.recent_spells) >= flagSpells,
    openAbsence: Number(row.open_count) > 0,
    rtwOutstanding: Number(row.rtw_outstanding),
  }));
}

/** Sickness minutes per person over a period — the payroll report's column. */
export async function getSicknessMinutes(from: string, to: string): Promise<Map<string, number>> {
  await materialiseOpenAbsences();
  const r = await query(
    `SELECT d.person_id, COALESCE(SUM(d.minutes), 0) AS minutes
       FROM staff_absence_days d
       JOIN staff_absences a ON a.id = d.absence_id
      WHERE d.is_active AND a.status = 'active'
        AND a.absence_type = 'sickness'
        AND d.absence_date BETWEEN $1::date AND $2::date
      GROUP BY d.person_id`,
    [from, to]
  );
  return new Map(r.rows.map(row => [row.person_id as string, Number(row.minutes)]));
}
