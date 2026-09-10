/**
 * Staff employment & working patterns — writes (Staff Calendar, Phase A).
 *
 * See docs/STAFF-CALENDAR-SPEC.md §3.1–3.3. Reads for the calendar live in
 * staff-day-status.ts; this file owns the mutations, because two rules must be
 * enforced in exactly one place:
 *
 *   1. Pattern ranges for a person NEVER overlap. The resolver picks "the
 *      pattern in force on this date" with .find(), so two overlapping rows
 *      would silently make the answer depend on row order.
 *
 *   2. `minutes` is computed from start/end/break HERE and stored. It is never
 *      derived at read time — see the note in migration 206.
 *
 * Changing someone's hours CLOSES the current pattern and opens a new one
 * (spec §0.3). It never edits in place: editing would retroactively rewrite
 * every historical calendar and, from Phase B, past balance maths.
 */

import { query, getClient } from '../config/database';
import { addDaysYmd, shiftMinutes, DATE_RE } from './staff-day-status';

/**
 * Who may manage staff records. Admin only for now (jon, Sep 2026) — but named
 * once so widening it to managers later is a one-line change here rather than
 * an audit of every route. Mirrors the hasManagerRole() chokepoint pattern.
 */
export const STAFF_ADMIN_ROLES = ['admin'] as const;

export interface PatternDayInput {
  weekday: number;            // 0 = Monday … 6 = Sunday
  cycleWeek?: number;         // 1 or 2; defaults to 1
  isWorking: boolean;
  startTime?: string | null;  // 'HH:MM'
  endTime?: string | null;
  breakMinutes?: number;
}

export interface EmploymentInput {
  startDate: string;
  endDate?: string | null;
  employmentStatus?: 'employed' | 'left';
  jobTitle?: string | null;
  department?: string | null;
  bankHolidayPolicy?: 'use_allowance' | 'granted' | null;
  entitlementWeeks?: number | null;
  notes?: string | null;
}

// ── Employment ──────────────────────────────────────────────────────────────

export async function upsertEmployment(personId: string, input: EmploymentInput, userId: string) {
  if (!DATE_RE.test(input.startDate)) throw new Error('startDate must be YYYY-MM-DD');
  if (input.endDate && !DATE_RE.test(input.endDate)) throw new Error('endDate must be YYYY-MM-DD');
  if (input.endDate && input.endDate < input.startDate) throw new Error('endDate must be on or after startDate');

  const r = await query(
    `INSERT INTO staff_employment
       (person_id, employment_status, start_date, end_date, job_title, department,
        bank_holiday_policy, entitlement_weeks, notes, created_by)
     VALUES ($1, COALESCE($2,'employed'), $3::date, $4::date, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (person_id) DO UPDATE SET
       employment_status   = COALESCE(EXCLUDED.employment_status, staff_employment.employment_status),
       start_date          = EXCLUDED.start_date,
       end_date            = EXCLUDED.end_date,
       job_title           = EXCLUDED.job_title,
       department          = EXCLUDED.department,
       bank_holiday_policy = EXCLUDED.bank_holiday_policy,
       entitlement_weeks   = EXCLUDED.entitlement_weeks,
       notes               = EXCLUDED.notes,
       updated_at          = NOW()
     RETURNING *`,
    [
      personId, input.employmentStatus ?? null, input.startDate, input.endDate ?? null,
      input.jobTitle ?? null, input.department ?? null, input.bankHolidayPolicy ?? null,
      input.entitlementWeeks ?? null, input.notes ?? null, userId,
    ]
  );
  return r.rows[0];
}

/** Full employee record: employment + the personal fields that already live on `people`. */
export async function getEmployeeRecord(personId: string) {
  const r = await query(
    `SELECT se.*,
            se.start_date::text AS start_date,
            se.end_date::text   AS end_date,
            p.first_name, p.last_name, p.preferred_name, p.email, p.phone, p.mobile,
            p.date_of_birth::text AS date_of_birth,
            p.home_address,
            p.emergency_contact_name, p.emergency_contact_phone, p.emergency_contact_relationship,
            p.emergency_contact_2_name, p.emergency_contact_2_phone, p.emergency_contact_2_relationship,
            p.rtw_checked_on::text AS rtw_checked_on, p.rtw_document_type,
            p.rtw_expires_on::text AS rtw_expires_on,
            p.licence_number, p.licence_expiry::text AS licence_expiry,
            p.passport_expiry::text AS passport_expiry,
            (p.ni_number_encrypted IS NOT NULL) AS has_ni_number
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.person_id = $1`,
    [personId]
  );
  return r.rows[0] ?? null;
}

export async function listEmployees() {
  const r = await query(
    `SELECT se.person_id, se.job_title, se.department, se.employment_status,
            se.start_date::text AS start_date,
            se.end_date::text   AS end_date,
            (p.first_name || ' ' || p.last_name) AS name,
            p.preferred_name, p.email,
            (SELECT sh.annual_amount FROM staff_salary_history sh
              WHERE sh.person_id = se.person_id
              ORDER BY sh.effective_from DESC, sh.created_at DESC LIMIT 1) AS current_salary,
            (SELECT sh.effective_from::text FROM staff_salary_history sh
              WHERE sh.person_id = se.person_id
              ORDER BY sh.effective_from DESC, sh.created_at DESC LIMIT 1) AS salary_since,
            (SELECT MIN(sr.scheduled_for)::text FROM staff_reviews sr
              WHERE sr.person_id = se.person_id AND sr.completed_at IS NULL) AS next_review_due
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE p.is_deleted = false
      ORDER BY se.employment_status, p.first_name, p.last_name`
  );
  return r.rows;
}

// ── Working patterns ────────────────────────────────────────────────────────

/**
 * Create a pattern effective from a date, closing whatever ran before it.
 *
 * The close sets the previous pattern's effective_to to the day before this
 * one starts, which is what keeps ranges non-overlapping without needing a
 * btree_gist exclusion constraint. Runs in a transaction: a half-applied
 * change would leave a person with two live patterns.
 */
export async function createPattern(
  personId: string,
  effectiveFrom: string,
  days: PatternDayInput[],
  opts: { cycleWeeks?: number; notes?: string | null } = {},
  userId?: string
) {
  if (!DATE_RE.test(effectiveFrom)) throw new Error('effectiveFrom must be YYYY-MM-DD');
  const cycleWeeks = opts.cycleWeeks ?? 1;
  if (cycleWeeks !== 1 && cycleWeeks !== 2) throw new Error('cycleWeeks must be 1 or 2');

  const rows = days.map(d => normalisePatternDay(d, cycleWeeks));
  const seen = new Set<string>();
  for (const d of rows) {
    const key = `${d.cycleWeek}:${d.weekday}`;
    if (seen.has(key)) throw new Error(`Duplicate day: cycle week ${d.cycleWeek}, weekday ${d.weekday}`);
    seen.add(key);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Replace a pattern starting on the SAME day — that is a correction of this
    // pattern, so the old version goes. Deliberately NOT `>=`: a later pattern
    // is somebody else's future arrangement and must survive an insertion in
    // front of it, otherwise adding a June pattern silently destroys October.
    await client.query(
      `DELETE FROM staff_working_patterns WHERE person_id = $1 AND effective_from = $2::date`,
      [personId, effectiveFrom]
    );

    // Close the pattern that was running when this one starts.
    await client.query(
      `UPDATE staff_working_patterns
          SET effective_to = $2::date, updated_at = NOW()
        WHERE person_id = $1
          AND effective_from < $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)`,
      [personId, addDaysYmd(effectiveFrom, -1), effectiveFrom]
    );

    // If a later pattern already exists, this one ends the day before it starts.
    // Without this the new row would be open-ended and overlap it, and the
    // resolver's "pattern in force on this date" .find() would depend on row
    // order — i.e. give a different answer on different days.
    const next = await client.query(
      `SELECT MIN(effective_from)::text AS next_from
         FROM staff_working_patterns
        WHERE person_id = $1 AND effective_from > $2::date`,
      [personId, effectiveFrom]
    );
    const nextFrom: string | null = next.rows[0]?.next_from ?? null;
    const effectiveTo = nextFrom ? addDaysYmd(nextFrom, -1) : null;

    const pat = await client.query(
      `INSERT INTO staff_working_patterns (person_id, effective_from, effective_to, cycle_weeks, notes, created_by)
       VALUES ($1, $2::date, $3::date, $4, $5, $6)
       RETURNING id`,
      [personId, effectiveFrom, effectiveTo, cycleWeeks, opts.notes ?? null, userId ?? null]
    );
    const patternId = pat.rows[0].id as string;

    for (const d of rows) {
      await client.query(
        `INSERT INTO staff_working_pattern_days
           (pattern_id, cycle_week, weekday, is_working, start_time, end_time, break_minutes, minutes)
         VALUES ($1, $2, $3, $4, $5::time, $6::time, $7, $8)`,
        [patternId, d.cycleWeek, d.weekday, d.isWorking, d.startTime, d.endTime, d.breakMinutes, d.minutes]
      );
    }

    await client.query('COMMIT');
    return { id: patternId, effectiveFrom, effectiveTo, cycleWeeks, days: rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validate one day and compute its minutes.
 *
 * Exported for tests: this is where a mistyped shift becomes a wrong number
 * that then propagates into every balance from Phase B onwards.
 */
export function normalisePatternDay(d: PatternDayInput, cycleWeeks = 1) {
  const cycleWeek = d.cycleWeek ?? 1;
  if (!Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6) {
    throw new Error(`weekday must be 0-6 (Monday-first), got ${d.weekday}`);
  }
  if (cycleWeek < 1 || cycleWeek > cycleWeeks) {
    throw new Error(`cycleWeek ${cycleWeek} outside a ${cycleWeeks}-week cycle`);
  }
  if (!d.isWorking) {
    return { cycleWeek, weekday: d.weekday, isWorking: false, startTime: null, endTime: null, breakMinutes: 0, minutes: 0 };
  }
  if (!d.startTime || !d.endTime) throw new Error('A working day needs both a start and an end time');

  const breakMinutes = d.breakMinutes ?? 0;
  if (breakMinutes < 0) throw new Error('breakMinutes cannot be negative');

  const minutes = shiftMinutes(d.startTime, d.endTime, breakMinutes);
  if (minutes <= 0) {
    throw new Error(
      `${d.startTime}–${d.endTime} less a ${breakMinutes}-minute break leaves ${minutes} minutes of work`
    );
  }
  return {
    cycleWeek, weekday: d.weekday, isWorking: true,
    startTime: d.startTime, endTime: d.endTime, breakMinutes, minutes,
  };
}

export async function listPatterns(personId: string) {
  const pats = await query(
    `SELECT id, effective_from::text AS effective_from, effective_to::text AS effective_to,
            cycle_weeks, notes, created_at
       FROM staff_working_patterns
      WHERE person_id = $1
      ORDER BY effective_from DESC`,
    [personId]
  );
  if (pats.rows.length === 0) return [];

  const days = await query(
    `SELECT pattern_id, cycle_week, weekday, is_working,
            start_time::text AS start_time, end_time::text AS end_time,
            break_minutes, minutes
       FROM staff_working_pattern_days
      WHERE pattern_id = ANY($1::uuid[])
      ORDER BY cycle_week, weekday`,
    [pats.rows.map((p: { id: string }) => p.id)]
  );

  return pats.rows.map((p: { id: string }) => ({
    ...p,
    days: days.rows.filter((d: { pattern_id: string }) => d.pattern_id === p.id),
    weeklyMinutes: days.rows
      .filter((d: { pattern_id: string }) => d.pattern_id === p.id)
      .reduce((sum: number, d: { minutes: number }) => sum + d.minutes, 0),
  }));
}

// ── Pattern exceptions (incl. swaps) ────────────────────────────────────────

export interface ExceptionInput {
  personId: string;
  date: string;
  isWorking: boolean;
  startTime?: string | null;
  endTime?: string | null;
  breakMinutes?: number;
  reason?: string | null;
}

/**
 * Create one or more exception legs as a single unit.
 *
 * One leg = an ad-hoc change. Two legs for one person = a self-swap. Four legs
 * across two people = a person-to-person swap. They share a swap_group_id and
 * are approved or declined together, so a half-applied swap is impossible.
 */
export async function createExceptions(legs: ExceptionInput[], userId: string, autoApprove: boolean) {
  if (legs.length === 0) throw new Error('At least one leg is required');

  const prepared = legs.map(l => {
    if (!DATE_RE.test(l.date)) throw new Error(`Date must be YYYY-MM-DD, got ${l.date}`);
    const n = normalisePatternDay(
      { weekday: 0, isWorking: l.isWorking, startTime: l.startTime, endTime: l.endTime, breakMinutes: l.breakMinutes },
      1
    );
    return { ...l, minutes: n.minutes, breakMinutes: n.breakMinutes, startTime: n.startTime, endTime: n.endTime };
  });

  const groupId = prepared.length > 1 ? await newUuid() : null;
  const status = autoApprove ? 'approved' : 'pending';
  // Resolve the approval fields HERE rather than with a CASE on the status
  // parameter in SQL. Reusing one pg parameter as both a varchar column value
  // and a text comparison operand makes Postgres reject the statement with
  // 42P08 ("inconsistent types deduced for parameter") — see CLAUDE.md.
  const approvedBy = autoApprove ? userId : null;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const l of prepared) {
      // A live exception already on that date is superseded — cancel it rather
      // than deleting, so the history of what was planned survives.
      await client.query(
        `UPDATE staff_pattern_exceptions
            SET status = 'cancelled', updated_at = NOW()
          WHERE person_id = $1 AND exception_date = $2::date AND status IN ('pending','approved')`,
        [l.personId, l.date]
      );
      const r = await client.query(
        `INSERT INTO staff_pattern_exceptions
           (person_id, exception_date, is_working, start_time, end_time, break_minutes,
            minutes, reason, swap_group_id, status, requested_by, approved_by, approved_at)
         VALUES ($1, $2::date, $3, $4::time, $5::time, $6, $7, $8, $9, $10, $11, $12,
                 CASE WHEN $12::uuid IS NULL THEN NULL ELSE NOW() END)
         RETURNING id, exception_date::text AS exception_date, is_working, minutes, status, swap_group_id`,
        [l.personId, l.date, l.isWorking, l.startTime, l.endTime, l.breakMinutes,
         l.minutes, l.reason ?? null, groupId, status, userId, approvedBy]
      );
      out.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function newUuid(): Promise<string> {
  const r = await query('SELECT gen_random_uuid() AS id');
  return r.rows[0].id;
}

export async function listExceptions(personId: string, from: string, to: string) {
  const r = await query(
    `SELECT id, exception_date::text AS exception_date, is_working,
            start_time::text AS start_time, end_time::text AS end_time,
            minutes, reason, swap_group_id, status
       FROM staff_pattern_exceptions
      WHERE person_id = $1 AND exception_date BETWEEN $2::date AND $3::date
      ORDER BY exception_date`,
    [personId, from, to]
  );
  return r.rows;
}

// ── Salary & reviews (admin only) ───────────────────────────────────────────

export async function addSalaryEntry(
  personId: string,
  annualAmount: number,
  effectiveFrom: string,
  reason: string | null,
  userId: string
) {
  if (!DATE_RE.test(effectiveFrom)) throw new Error('effectiveFrom must be YYYY-MM-DD');
  if (!Number.isFinite(annualAmount) || annualAmount < 0) throw new Error('annualAmount must be a positive number');
  const r = await query(
    `INSERT INTO staff_salary_history (person_id, annual_amount, effective_from, reason, created_by)
     VALUES ($1, $2, $3::date, $4, $5)
     RETURNING id, annual_amount, effective_from::text AS effective_from, reason, created_at`,
    [personId, annualAmount, effectiveFrom, reason, userId]
  );
  return r.rows[0];
}

export async function listSalaryHistory(personId: string) {
  const r = await query(
    `SELECT id, annual_amount, effective_from::text AS effective_from, reason, created_at
       FROM staff_salary_history
      WHERE person_id = $1
      ORDER BY effective_from DESC, created_at DESC`,
    [personId]
  );
  return r.rows;
}

export async function upsertReview(
  id: string | null,
  personId: string,
  input: { reviewType?: string; scheduledFor: string; completedAt?: string | null; notes?: string | null; outcome?: string | null; nextReviewDue?: string | null },
  userId: string
) {
  if (!DATE_RE.test(input.scheduledFor)) throw new Error('scheduledFor must be YYYY-MM-DD');
  if (id) {
    const r = await query(
      `UPDATE staff_reviews
          SET review_type = COALESCE($3, review_type),
              scheduled_for = $4::date,
              completed_at = $5,
              notes = $6, outcome = $7,
              next_review_due = $8::date,
              updated_at = NOW()
        WHERE id = $1 AND person_id = $2
        RETURNING *`,
      [id, personId, input.reviewType ?? null, input.scheduledFor, input.completedAt ?? null,
       input.notes ?? null, input.outcome ?? null, input.nextReviewDue ?? null]
    );
    return r.rows[0] ?? null;
  }
  const r = await query(
    `INSERT INTO staff_reviews (person_id, review_type, scheduled_for, completed_at, notes, outcome, next_review_due, created_by)
     VALUES ($1, COALESCE($2,'annual'), $3::date, $4, $5, $6, $7::date, $8)
     RETURNING *`,
    [personId, input.reviewType ?? null, input.scheduledFor, input.completedAt ?? null,
     input.notes ?? null, input.outcome ?? null, input.nextReviewDue ?? null, userId]
  );
  return r.rows[0];
}

export async function listReviews(personId: string) {
  const r = await query(
    `SELECT id, review_type, scheduled_for::text AS scheduled_for, completed_at,
            notes, outcome, next_review_due::text AS next_review_due, created_at
       FROM staff_reviews
      WHERE person_id = $1
      ORDER BY scheduled_for DESC`,
    [personId]
  );
  return r.rows;
}
