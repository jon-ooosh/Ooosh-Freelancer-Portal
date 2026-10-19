/**
 * Hire lifecycle helpers — distinguishing a GENUINE end-of-hire return from a
 * MID-HIRE partial item check-in.
 *
 * HireHop status 6 ("Returned Incomplete") is ambiguous: it fires both when a
 * tour genuinely comes back and staff start checking items in, AND when a client
 * hands back ONE element mid-hire (e.g. two keyboard stands) while the rest of
 * the hire stays out for another week. HireHop can't tell the two apart — its
 * status is job-level and binary. OP's discriminator is the hire-END DATE: a
 * status-6 job is only "genuinely returning" once its expected return date has
 * arrived (within a day of tolerance). HH status 7 (Returned) / 8 (Requires
 * Attention) / 11 (Completed) all mean everything is physically back, so they're
 * always genuinely returned regardless of date.
 *
 * Without this distinction, a mid-hire partial check-in flips OP into the
 * returns process prematurely: it spins up close-out requirements (invoice,
 * payment reconcile, client follow-up…), the daily chase scanner starts nagging
 * to invoice a job that's still on the road, and the dispatch excess/referral
 * gate switches off. See CLAUDE.md → "The status-6 no man's land".
 */

import { query } from '../config/database';

/** Days of tolerance around the expected return date before a status-6 job is
 *  treated as genuinely returning. return_date is already Ooosh's +1 buffer,
 *  so +1 here is effectively "on or after the real job end". */
export const HIRE_END_TOLERANCE_DAYS = 1;

/** HH statuses that always mean "everything physically back" — no date gate. */
const FULLY_BACK_STATUSES = new Set([7, 8, 11]);

/**
 * True when a HireHop status reflects a genuine end-of-hire return, not a
 * mid-hire partial check-in.
 *   - status 7 / 8 / 11 → always true (everything back / terminal)
 *   - status 6          → true only once the hire-end date has arrived (± tolerance)
 *   - anything else     → false (not a return state)
 * A status-6 job with no known end date falls back to true, so we never hold a
 * dateless job in limbo forever.
 */
export function hireGenuinelyReturning(
  hhStatus: number | null | undefined,
  returnDate: Date | string | null | undefined,
  jobEnd: Date | string | null | undefined,
): boolean {
  const s = hhStatus == null ? null : Number(hhStatus);
  if (s == null || Number.isNaN(s)) return false;
  if (FULLY_BACK_STATUSES.has(s)) return true;
  // Only "Returned Incomplete" (6) is the ambiguous partial state.
  if (s !== 6) return false;

  const end = returnDate ?? jobEnd;
  if (!end) return true; // no date known — don't hold indefinitely
  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) return true;

  // Compare calendar dates. "Genuinely returning" once today is within
  // HIRE_END_TOLERANCE_DAYS of (or past) the expected return date.
  const now = new Date();
  const endMidnight = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilEnd = Math.round((endMidnight - todayMidnight) / 86_400_000);
  return daysUntilEnd <= HIRE_END_TOLERANCE_DAYS;
}

/**
 * SQL fragment for "this job's HireHop status is a genuine return" — the same
 * rule as hireGenuinelyReturning(), for use inside WHERE / FILTER clauses.
 * `alias` is the jobs-table alias in the surrounding query.
 */
export function hireGenuinelyReturningSql(alias = 'j'): string {
  const endReached =
    `(COALESCE(${alias}.return_date, ${alias}.job_end) IS NULL ` +
    `OR COALESCE(${alias}.return_date, ${alias}.job_end)::date <= CURRENT_DATE + INTERVAL '${HIRE_END_TOLERANCE_DAYS} day')`;
  return `(${alias}.status IN (7, 8, 11) OR (${alias}.status = 6 AND ${endReached}))`;
}

/** Pipeline statuses a job can be "held" in — i.e. still operationally out on
 *  hire when HH flipped to 6 on a partial check-in. Never hold a job that's
 *  already been advanced into (or past) the returns process — that's a
 *  deliberate human/HH decision we must not wind back. */
export const HELD_OUT_PIPELINE_STATUSES = ['dispatched', 'prepped', 'prepping'];

/**
 * Reconcile jobs that were HELD out-on-hire when HireHop reported "Returned
 * Incomplete" (6) mid-hire (a partial early item return), and whose return date
 * has now actually arrived. Advances them into the returns process so the
 * badge, close-out cards and Returns page catch up.
 *
 * Also a belt-and-braces fix for the general webhook-gap case: any job sitting
 * at HH status 6 with an out-on-hire pipeline_status whose return date has
 * passed (because a returned webhook never landed) gets advanced too.
 *
 * Only ever moves FORWARD (out → returns). It never touches a job already in a
 * returns/terminal pipeline_status, so a status staff manually advanced is safe.
 */
export async function reconcileHeldReturns(): Promise<{ reconciled: number }> {
  const due = await query(
    `SELECT id, hh_job_number, pipeline_status
       FROM jobs
      WHERE is_deleted = false
        AND status = 6
        AND pipeline_status = ANY($1)
        AND (COALESCE(return_date, job_end) IS NULL
             OR COALESCE(return_date, job_end)::date <= CURRENT_DATE + INTERVAL '${HIRE_END_TOLERANCE_DAYS} day')`,
    [HELD_OUT_PIPELINE_STATUSES],
  );

  let reconciled = 0;
  for (const job of due.rows) {
    await query(
      `UPDATE jobs
          SET pipeline_status = 'returned_incomplete',
              pipeline_status_changed_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [job.id],
    );
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
       VALUES ('status_transition', $1, $2, NULL, $3, 'system')`,
      [
        'Hire now due back — moved to Checking In (was held on hire after an item was checked in early mid-hire).',
        job.id,
        job.pipeline_status,
      ],
    );
    // Spin up the close-out requirements now rather than waiting for the next
    // 30-min derivation cycle.
    try {
      const { deriveRequirementsForJob } = await import('./hh-requirement-derivation');
      await deriveRequirementsForJob(job.id);
    } catch (err) {
      console.warn(`[reconcileHeldReturns] derive failed for job ${job.id}:`, err);
    }
    reconciled++;
  }

  if (reconciled > 0) {
    console.log(`[reconcileHeldReturns] Advanced ${reconciled} held job(s) into the returns process`);
  }
  return { reconciled };
}
