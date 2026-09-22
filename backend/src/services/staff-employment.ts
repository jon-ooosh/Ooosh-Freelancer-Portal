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
  probationEndDate?: string | null;
  noticePeriodDays?: number | null;
  /** Review cadence for this person; NULL inherits the company setting (§5.6). */
  reviewIntervalMonths?: number | null;
  notes?: string | null;
  /** Personal fields that live on `people`, written in the same call. */
  preferredName?: string | null;
  pronouns?: string | null;
}

// ── Employment ──────────────────────────────────────────────────────────────

export async function upsertEmployment(personId: string, input: EmploymentInput, userId: string) {
  if (!DATE_RE.test(input.startDate)) throw new Error('startDate must be YYYY-MM-DD');
  if (input.endDate && !DATE_RE.test(input.endDate)) throw new Error('endDate must be YYYY-MM-DD');
  if (input.endDate && input.endDate < input.startDate) throw new Error('endDate must be on or after startDate');

  const r = await query(
    `INSERT INTO staff_employment
       (person_id, employment_status, start_date, end_date, job_title, department,
        bank_holiday_policy, entitlement_weeks, notes, created_by,
        probation_end_date, notice_period_days, review_interval_months)
     VALUES ($1, COALESCE($2,'employed'), $3::date, $4::date, $5, $6, $7, $8, $9, $10,
             $11::date, $12, $13)
     ON CONFLICT (person_id) DO UPDATE SET
       employment_status   = COALESCE(EXCLUDED.employment_status, staff_employment.employment_status),
       start_date          = EXCLUDED.start_date,
       end_date            = EXCLUDED.end_date,
       job_title           = EXCLUDED.job_title,
       department          = EXCLUDED.department,
       bank_holiday_policy = EXCLUDED.bank_holiday_policy,
       entitlement_weeks   = EXCLUDED.entitlement_weeks,
       notes               = EXCLUDED.notes,
       probation_end_date  = EXCLUDED.probation_end_date,
       notice_period_days  = EXCLUDED.notice_period_days,
       review_interval_months = EXCLUDED.review_interval_months,
       updated_at          = NOW()
     RETURNING *`,
    [
      personId, input.employmentStatus ?? null, input.startDate, input.endDate ?? null,
      input.jobTitle ?? null, input.department ?? null, input.bankHolidayPolicy ?? null,
      input.entitlementWeeks ?? null, input.notes ?? null, userId,
      input.probationEndDate ?? null, input.noticePeriodDays ?? null,
      input.reviewIntervalMonths ?? null,
    ]
  );

  // preferred_name and pronouns live on `people`, not staff_employment —
  // they describe the person, not the employment, and the freelancer flows
  // already read preferred_name from there. Written here only when supplied,
  // so an employment-only save never blanks them.
  // Built from the keys actually supplied, NOT with COALESCE: coalescing would
  // make an empty value fall back to the old one, so clearing a preferred name
  // would silently do nothing. Absent key = leave alone; empty string = clear.
  const personSets: string[] = [];
  const personParams: unknown[] = [personId];
  if (input.preferredName !== undefined) {
    personParams.push(input.preferredName === '' ? null : input.preferredName);
    personSets.push(`preferred_name = $${personParams.length}`);
  }
  if (input.pronouns !== undefined) {
    personParams.push(input.pronouns === '' ? null : input.pronouns);
    personSets.push(`pronouns = $${personParams.length}`);
  }
  if (personSets.length > 0) {
    await query(
      `UPDATE people SET ${personSets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      personParams
    );
  }
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
            (SELECT MIN(sr.scheduled_for)::text FROM staff_reviews sr
              WHERE sr.person_id = se.person_id AND sr.status IN ('proposed','confirmed')
            ) AS next_review_scheduled,
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
            se.bank_holiday_policy, se.entitlement_weeks,
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
            -- Keyed on status, NOT on a null completed_at: a CANCELLED review
            -- also has no completion date, so the old test showed a review
            -- somebody called off as permanently upcoming (status: mig 234).
            (SELECT MIN(sr.scheduled_for)::text FROM staff_reviews sr
              WHERE sr.person_id = se.person_id
                AND sr.status IN ('proposed','confirmed')) AS next_review_due
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

/**
 * Create or amend a review. docs/STAFF-RECORDS-SPEC.md §5.
 *
 * TWO NOTES FIELDS, never one (spec §5.4):
 *   shared_summary — the reviewee sees this; it is what the follow-up email
 *                    contains anyway
 *   private_notes  — admin only: observations, concerns not yet raised, pay
 *                    reasoning
 * A single field that is SOMETIMES shared is a leak waiting to happen, and
 * knowing it might be read, the reviewer self-censors into uselessness.
 *
 * PAY IS NOT HELD HERE (spec §5.1). A review points at the
 * staff_salary_history row it produced — see recordReviewOutcome. Deciding pay
 * in the room is what stops the honest half of the conversation happening.
 */
export async function upsertReview(
  id: string | null,
  personId: string,
  input: {
    reviewType?: string; scheduledFor: string; status?: string;
    completedAt?: string | null; sharedSummary?: string | null;
    privateNotes?: string | null; outcome?: string | null; nextReviewDue?: string | null;
  },
  userId: string
) {
  if (!DATE_RE.test(input.scheduledFor)) throw new Error('scheduledFor must be YYYY-MM-DD');
  if (input.nextReviewDue && !DATE_RE.test(input.nextReviewDue)) {
    throw new Error('nextReviewDue must be YYYY-MM-DD');
  }

  const row = id
    ? (await query(
        `UPDATE staff_reviews
            SET review_type = COALESCE($3, review_type),
                scheduled_for = $4::date,
                status = COALESCE($5, status),
                completed_at = $6,
                shared_summary = $7, private_notes = $8, outcome = $9,
                next_review_due = $10::date,
                updated_at = NOW()
          WHERE id = $1 AND person_id = $2
          RETURNING *`,
        [id, personId, input.reviewType ?? null, input.scheduledFor, input.status ?? null,
         input.completedAt ?? null, input.sharedSummary ?? null, input.privateNotes ?? null,
         input.outcome ?? null, input.nextReviewDue ?? null]
      )).rows[0] ?? null
    : (await query(
        `INSERT INTO staff_reviews
           (person_id, review_type, scheduled_for, status, completed_at,
            shared_summary, private_notes, outcome, next_review_due, created_by)
         VALUES ($1, COALESCE($2,'annual'), $3::date, COALESCE($4,'proposed'), $5,
                 $6, $7, $8, $9::date, $10)
         RETURNING *`,
        [personId, input.reviewType ?? null, input.scheduledFor, input.status ?? null,
         input.completedAt ?? null, input.sharedSummary ?? null, input.privateNotes ?? null,
         input.outcome ?? null, input.nextReviewDue ?? null, userId]
      )).rows[0];

  if (!row) return null;

  // Booking or finishing a review answers the "this is due" reminder, so the
  // stamp clears and the NEXT cycle can chase again. Without this the nudge
  // fires once per person ever.
  await query(
    'UPDATE staff_employment SET review_due_chased_at = NULL WHERE person_id = $1',
    [personId]
  );

  return row;
}

/**
 * Complete a review: stamp it, set when the next one falls due, and — if a pay
 * rise came out of it — write the salary row and link the two.
 *
 * `next_review_due` is DERIVED from the person's own cadence
 * (staff_employment.review_interval_months, falling back to the company
 * setting) rather than typed, so "annual for most, six-monthly for a new
 * starter" needs no thought at the point of completing.
 *
 * The salary row is append-only and already THE record of what somebody is on
 * (mig 206). This adds the link back, so "what did this review actually lead
 * to" is answerable — and so the follow-up email has the figure to quote.
 */
export async function recordReviewOutcome(
  reviewId: string,
  personId: string,
  input: {
    sharedSummary?: string | null; privateNotes?: string | null; outcome?: string | null;
    newSalary?: number | null; salaryEffectiveFrom?: string | null; salaryReason?: string | null;
  },
  userId: string
) {
  const emp = await query(
    'SELECT review_interval_months FROM staff_employment WHERE person_id = $1',
    [personId]
  );
  let months = emp.rows[0]?.review_interval_months as number | null | undefined;
  if (months == null) {
    const { getReviewIntervalMonths } = await import('./staff-settings');
    months = await getReviewIntervalMonths();
  }

  let salaryId: string | null = null;
  if (input.newSalary != null) {
    if (!(input.newSalary >= 0)) throw new Error('A salary cannot be negative');
    const effective = input.salaryEffectiveFrom || new Date().toISOString().slice(0, 10);
    if (!DATE_RE.test(effective)) throw new Error('salaryEffectiveFrom must be YYYY-MM-DD');
    const sal = await query(
      `INSERT INTO staff_salary_history (person_id, annual_amount, effective_from, reason, created_by)
       VALUES ($1, $2, $3::date, $4, $5) RETURNING id`,
      [personId, input.newSalary, effective,
       input.salaryReason?.trim() || 'Agreed at review', userId]
    );
    salaryId = sal.rows[0].id;
  }

  const r = await query(
    `UPDATE staff_reviews
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            shared_summary = COALESCE($3, shared_summary),
            private_notes  = COALESCE($4, private_notes),
            outcome        = COALESCE($5, outcome),
            salary_history_id = COALESCE($6, salary_history_id),
            next_review_due = (CURRENT_DATE + ($7 || ' months')::interval)::date,
            updated_at = NOW()
      WHERE id = $1 AND person_id = $2
      RETURNING *`,
    [reviewId, personId, input.sharedSummary ?? null, input.privateNotes ?? null,
     input.outcome ?? null, salaryId, String(months)]
  );
  if (!r.rows.length) throw new Error('Review not found');

  await query(
    'UPDATE staff_employment SET review_due_chased_at = NULL WHERE person_id = $1',
    [personId]
  );
  return r.rows[0];
}

/**
 * Reviews for one person.
 *
 * `includePrivate` is the §5.4 split made real: the admin surface passes true,
 * and anything staff-facing passes false so private_notes never leaves the
 * server. Defaulting to FALSE is deliberate — a new caller that forgets to
 * think about it gets the safe answer.
 */
export async function listReviews(personId: string, includePrivate = false) {
  const r = await query(
    `SELECT id, review_type, scheduled_for::text AS scheduled_for, status,
            completed_at, shared_summary,
            ${includePrivate ? 'private_notes,' : 'NULL::text AS private_notes,'}
            outcome, next_review_due::text AS next_review_due,
            salary_history_id, created_at
       FROM staff_reviews
      WHERE person_id = $1
      ORDER BY scheduled_for DESC`,
    [personId]
  );
  return r.rows;
}

// ── Unified staff roster ────────────────────────────────────────────────────

export interface RosterRow {
  personId: string;
  userId: string | null;
  name: string;
  preferredName: string | null;
  pronouns: string | null;
  email: string | null;
  avatarUrl: string | null;
  account: { role: string; isActive: boolean; hhUserId: number | null } | null;
  employment: {
    status: string;
    startDate: string;
    endDate: string | null;
    jobTitle: string | null;
    department: string | null;
    bankHolidayPolicy: 'use_allowance' | 'granted' | null;
    entitlementWeeks: string | null;
    probationEndDate: string | null;
    noticePeriodDays: number | null;
  } | null;
  weeklyMinutes: number | null;
  hasPattern: boolean;
  cotCard: {
    last4: string | null;
    label: string | null;
    /** Card-agreement state from the staff-documents module, carried over from
     *  the old Settings register so the "who hasn't signed" signal is not lost. */
    agreementStatus: string | null;
    agreementCompletedAt: string | null;
  } | null;
}

/**
 * Everyone who either holds a user account OR has an employment record.
 *
 * The two sets genuinely differ and neither is a subset of the other: service
 * and test accounts (System Service, TEST Wood) have logins but are not
 * employees, and an employee could exist before their login is created. Keying
 * this page on one table alone would make the other set unmanageable, so the
 * roster is the UNION and each row says plainly what it has and what it lacks.
 *
 * `isAdmin` decides how much comes back. Employment, hours and card details are
 * admin-only and are omitted entirely — not blanked client-side — so a manager's
 * response never carries them. Account fields are manager-tier, matching the
 * access PUT /users/:id already grants.
 */
export async function getStaffRoster(isAdmin: boolean): Promise<RosterRow[]> {
  const r = await query(
    `SELECT p.id                                   AS person_id,
            (p.first_name || ' ' || p.last_name)   AS name,
            p.preferred_name,
            u.id                                   AS user_id,
            COALESCE(u.email, p.email)             AS email,
            u.avatar_url,
            u.role,
            u.is_active,
            u.hh_user_id,
            u.cot_card_last4,
            u.cot_card_label,
            se.employment_status,
            se.start_date::text                    AS start_date,
            se.end_date::text                      AS end_date,
            se.job_title,
            se.department,
            se.bank_holiday_policy,
            se.entitlement_weeks,
            se.probation_end_date::text AS probation_end_date,
            se.notice_period_days,
            p.pronouns,
            pat.weekly_minutes,
            agr.status       AS agreement_status,
            agr.completed_at AS agreement_completed_at
       FROM people p
       -- One account per person. A person with more than one row (shouldn't
       -- happen, but nothing enforces it) resolves to the active/newest.
       LEFT JOIN LATERAL (
         SELECT * FROM users u2
          WHERE u2.person_id = p.id
          ORDER BY u2.is_active DESC, u2.created_at DESC
          LIMIT 1
       ) u ON true
       LEFT JOIN staff_employment se ON se.person_id = p.id
       -- Contracted minutes per week under the pattern in force TODAY,
       -- normalised for a 2-week cycle so the figure is comparable across staff.
       LEFT JOIN LATERAL (
         SELECT ROUND(SUM(d.minutes)::numeric / wp.cycle_weeks) AS weekly_minutes
           FROM staff_working_patterns wp
           JOIN staff_working_pattern_days d ON d.pattern_id = wp.id
          WHERE wp.person_id = p.id
            AND wp.effective_from <= CURRENT_DATE
            AND (wp.effective_to IS NULL OR wp.effective_to >= CURRENT_DATE)
          GROUP BY wp.id, wp.cycle_weeks
          LIMIT 1
       ) pat ON true
       -- COT card agreement, from the staff-documents module. LATERAL rather
       -- than a plain join so a second document version can never fan a person
       -- into two roster rows.
       LEFT JOIN LATERAL (
         SELECT a.status, c.completed_at
           FROM staff_documents d
           JOIN staff_document_assignments a ON a.user_id = u.id AND a.document_id = d.id
           LEFT JOIN staff_document_completions c ON c.id = a.current_completion_id
          WHERE d.slug = 'cot-card-agreement'
          ORDER BY c.completed_at DESC NULLS LAST
          LIMIT 1
       ) agr ON true
      WHERE p.is_deleted = false
        AND (u.id IS NOT NULL OR se.person_id IS NOT NULL)
      ORDER BY (se.person_id IS NULL),          -- employees first
               (u.is_active IS NOT TRUE),        -- then inactive accounts last
               p.first_name, p.last_name`
  );

  return r.rows.map((row: Record<string, unknown>): RosterRow => ({
    personId: row.person_id as string,
    userId: (row.user_id as string) ?? null,
    name: row.name as string,
    preferredName: (row.preferred_name as string) ?? null,
    pronouns: (row.pronouns as string) ?? null,
    email: (row.email as string) ?? null,
    avatarUrl: (row.avatar_url as string) ?? null,
    account: row.user_id
      ? { role: row.role as string, isActive: row.is_active === true, hhUserId: (row.hh_user_id as number) ?? null }
      : null,
    employment: isAdmin && row.start_date
      ? {
          status: row.employment_status as string,
          startDate: row.start_date as string,
          endDate: (row.end_date as string) ?? null,
          jobTitle: (row.job_title as string) ?? null,
          department: (row.department as string) ?? null,
          bankHolidayPolicy: (row.bank_holiday_policy as 'use_allowance' | 'granted') ?? null,
          entitlementWeeks: row.entitlement_weeks != null ? String(row.entitlement_weeks) : null,
          probationEndDate: (row.probation_end_date as string) ?? null,
          noticePeriodDays: row.notice_period_days != null ? Number(row.notice_period_days) : null,
        }
      : null,
    // A non-admin must not learn someone's hours, so this is null rather than 0
    // — the UI distinguishes "not set up" from "not yours to see".
    weeklyMinutes: isAdmin && row.weekly_minutes != null ? Number(row.weekly_minutes) : null,
    hasPattern: isAdmin ? row.weekly_minutes != null : false,
    cotCard: isAdmin && row.user_id
      ? {
          last4: (row.cot_card_last4 as string) ?? null,
          label: (row.cot_card_label as string) ?? null,
          agreementStatus: (row.agreement_status as string) ?? null,
          agreementCompletedAt: row.agreement_completed_at
            ? new Date(row.agreement_completed_at as string).toISOString()
            : null,
        }
      : null,
  }));
}


// ── Linking a login to a staff record ───────────────────────────────────────

/**
 * Active logins whose person has NO employment record.
 *
 * These are the candidates for linking to an employee created against a
 * different `people` row — the situation that arises when someone is added as
 * an employee by picking the wrong duplicate out of the address book. Their
 * login then points at one person while their hours and balances sit on
 * another, so My Time shows nothing and every request is refused.
 */
export async function listUnlinkedLogins() {
  const r = await query(
    `SELECT u.id AS user_id, u.email, u.role, u.last_login,
            (p.first_name || ' ' || p.last_name) AS name
       FROM users u
       JOIN people p ON p.id = u.person_id
      WHERE u.is_active = true
        AND u.role <> 'freelancer'
        -- The seeded System Service account (migration 001 gives it the
        -- all-zeros person id, deterministically). Offering it here would let
        -- someone point the service account at a staff record by mistake,
        -- which leaves the real person no better off and the automation worse.
        AND u.person_id <> '00000000-0000-0000-0000-000000000000'::uuid
        AND NOT EXISTS (SELECT 1 FROM staff_employment se WHERE se.person_id = u.person_id)
      -- People who actually sign in first; dormant logins are rarely the answer.
      ORDER BY u.last_login DESC NULLS LAST, p.first_name, p.last_name`
  );
  return r.rows;
}

/**
 * Point an existing login at a staff record.
 *
 * Moves `users.person_id`, which is the ONE column that defines whose staff
 * record a login sees. The alternative — moving the employment, patterns and
 * ledger onto the login's person — is not possible: staff_ledger_entries is
 * append-only and refuses UPDATE, by design.
 *
 * The previously-linked person row is left alone in the address book. It keeps
 * its interactions and job history, which belong to that record; only the
 * login moves.
 */
export async function linkLoginToPerson(personId: string, userId: string) {
  const emp = await query(`SELECT 1 FROM staff_employment WHERE person_id = $1`, [personId]);
  if (emp.rows.length === 0) throw new Error('That person has no employment record');

  const taken = await query(
    `SELECT u.email FROM users u WHERE u.person_id = $1 AND u.id <> $2`, [personId, userId]);
  if (taken.rows.length > 0) {
    throw new Error(`${taken.rows[0].email} is already linked to this staff record`);
  }

  const r = await query(
    `UPDATE users SET person_id = $1, updated_at = NOW() WHERE id = $2 RETURNING email`,
    [personId, userId]
  );
  if (r.rows.length === 0) throw new Error('Login not found');
  return r.rows[0];
}

// ── Key data: NI number + right to work (spec §3.2) ─────────────────────────
//
// These columns live on `people`, added by migration 206, and this is the only
// place that writes them. NOT copied onto staff_employment: right to work is a
// fact about a person, not about one employment record, and a second copy is
// the mistake spec §1.1 documents on licence data.
//
// They are stripped from every general people response by
// services/people-private-fields.ts — the admin staff surfaces read them by
// name instead. If you add another private column to `people`, add it there.

export interface KeyDataInput {
  /** Plain NI number. Encrypted here; never stored or logged in the clear.
   *  '' clears it. Absent leaves whatever is stored alone. */
  niNumber?: string | null;
  rtwDocumentType?: string | null;
  rtwCheckedOn?: string | null;
  rtwExpiresOn?: string | null;
}

/** Normalised for storage: "ab 12 34 56 c" -> "AB123456C". */
function normaliseNi(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

// Format per HMRC: two letters, six digits, then A–D or a space. Deliberately a
// WARNING not a gate elsewhere in this codebase's spirit — but here it IS
// enforced, because an NI number is retyped from a document exactly once and a
// typo is silently wrong forever. Better to reject at the point of entry.
const NI_RE = /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;

export async function updateKeyData(personId: string, input: KeyDataInput, userId: string) {
  const sets: string[] = [];
  const params: unknown[] = [personId];

  if (input.niNumber !== undefined) {
    if (input.niNumber === null || input.niNumber.trim() === '') {
      sets.push('ni_number_encrypted = NULL');
    } else {
      const ni = normaliseNi(input.niNumber);
      if (!NI_RE.test(ni)) {
        throw new Error('That does not look like a National Insurance number (e.g. QQ123456C).');
      }
      // Imported lazily so a server without ENCRYPTION_KEY still boots and
      // serves everything else — the route checks isEncryptionConfigured()
      // first and refuses cleanly rather than throwing a 500 here.
      const { encrypt } = await import('./encryption');
      params.push(encrypt(ni));
      sets.push(`ni_number_encrypted = $${params.length}`);
    }
  }

  // Absent key = leave alone; empty = clear. Same rule as preferredName above,
  // and for the same reason: COALESCE would make clearing a value silently
  // do nothing.
  const dateFields: [keyof KeyDataInput, string][] = [
    ['rtwCheckedOn', 'rtw_checked_on'],
    ['rtwExpiresOn', 'rtw_expires_on'],
  ];
  for (const [key, column] of dateFields) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null || value === '') {
      sets.push(`${column} = NULL`);
    } else {
      if (!DATE_RE.test(String(value))) throw new Error(`${column} must be YYYY-MM-DD`);
      params.push(value);
      sets.push(`${column} = $${params.length}::date`);
    }
  }

  if (input.rtwDocumentType !== undefined) {
    const v = input.rtwDocumentType?.trim();
    params.push(v || null);
    sets.push(`rtw_document_type = $${params.length}`);
  }

  // Stamp WHO did the check whenever any right-to-work field is touched. The
  // check is the legal record, not the document — "seen by, on" is the bit an
  // inspection asks for.
  const touchedRtw = input.rtwDocumentType !== undefined
    || input.rtwCheckedOn !== undefined
    || input.rtwExpiresOn !== undefined;
  if (touchedRtw) {
    params.push(userId);
    sets.push(`rtw_checked_by = $${params.length}`);
  }

  if (!sets.length) throw new Error('No fields to update');

  const r = await query(
    `UPDATE people SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    params
  );
  if (!r.rows.length) throw new Error('Person not found');

  // Audited WITHOUT the value — that somebody's NI was set is worth recording;
  // putting the number in audit_log would undo the encryption it was just
  // given.
  const { logAudit } = await import('../middleware/audit');
  await logAudit(userId, 'people', personId, 'update', null, {
    key_data_changed: sets.map(s => s.split(' ')[0]),
  });

  return getEmployeeRecord(personId);
}

/**
 * Reveal the stored NI number, once, deliberately, and on the record.
 *
 * Every other read returns `has_ni_number` as a boolean (see
 * getEmployeeRecord) — the number itself only ever leaves the server through
 * here, and every call writes an audit_log row. Migration 232 widened the
 * audit action CHECK to allow 'read' for exactly this.
 */
export async function revealNiNumber(personId: string, userId: string): Promise<string | null> {
  const r = await query(
    'SELECT ni_number_encrypted FROM people WHERE id = $1',
    [personId]
  );
  if (!r.rows.length) throw new Error('Person not found');
  const stored = r.rows[0].ni_number_encrypted as string | null;
  if (!stored) return null;

  const { tryDecrypt } = await import('./encryption');
  const value = tryDecrypt(stored);

  const { logAudit } = await import('../middleware/audit');
  await logAudit(userId, 'people', personId, 'read', null, { field: 'ni_number' });

  return value;
}
