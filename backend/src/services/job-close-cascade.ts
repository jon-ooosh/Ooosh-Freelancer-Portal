/**
 * Job Close Cascade — transport/crew/vehicle cleanup when a job dies.
 *
 * THE single definition of "what happens to the transport side of a job when
 * it goes lost or cancelled". Cancels the quotes, cancels the crew
 * assignments, sweeps stray vehicle_hire_assignments, and tells affected
 * freelancers.
 *
 * Why this exists (Sep 2026): the cascade was written inline in
 * `PATCH /api/pipeline/:id/status` and, separately and slightly differently,
 * in `POST /api/cancellations/:jobId/process`. Two of the four paths that
 * actually close a job had NO cascade at all:
 *
 *   - the 09:00 stale-enquiry auto-loser (`config/scheduler.ts`) — unattended,
 *     runs daily, and left live quotes + crew assignments behind on every
 *     auto-lost enquiry that had transport on it. Job 16505 is the worked
 *     example: auto-lost 31 Aug, both its quotes still `confirmed` afterwards.
 *   - the HireHop webhook (`routes/webhooks.ts`) — staff marking a job
 *     "Not Interested" in HH flipped `pipeline_status` and nothing else.
 *     Note the auto-loser WRITES BACK to HH status 10, so these two gaps sat
 *     directly downstream of each other.
 *
 * Unattended callers pass `actorUserId: null` — there's no logged-in user on
 * a cron tick or a webhook.
 *
 * Deliberately NOT in here: the `job_requirements` sweep. That lives in
 * pipeline.ts / cancellations.ts because it depends on the staff-supplied
 * keep-list AND must run AFTER the event-trigger pass (reminders set to fire
 * on `lost`/`cancelled` need to fire before they're swept). Folding it in
 * would silently break that ordering. See CLAUDE.md → "Lost / Cancelled
 * cleanup pattern".
 */
import { query } from '../config/database';
import emailService from './email-service';

export type JobCloseReason = 'lost' | 'cancelled';

/**
 * Markers written to `quotes.cancelled_reason`, so a resurrection can tell
 * "we cancelled this because the job died" from "a human cancelled this
 * quote". Same marker convention as `requirement-cleanup.ts` and the
 * vehicle_hire_assignments notes sweep.
 *
 * The two bare strings are the pre-marker reasons written by the original
 * inline cascades (Sep 2026 and earlier) — matched on reactivation so rows
 * cancelled before this refactor still resurrect correctly.
 */
export const LOST_QUOTE_MARKER = '[Auto-cancelled: job marked lost]';
export const CANCELLED_QUOTE_MARKER = '[Auto-cancelled: job cancelled]';
const LEGACY_LOST_REASON = 'Parent job marked lost';
const LEGACY_CANCELLED_REASON = 'Parent job cancelled';

export interface JobCloseCascadeOptions {
  jobId: string;
  reason: JobCloseReason;
  /** Logged-in user, or null on unattended paths (cron, webhook). */
  actorUserId?: string | null;
}

export interface JobCloseCascadeResult {
  quotesCancelled: number;
  assignmentsCancelled: number;
  vehicleAssignmentsCancelled: number;
  crewEmailed: number;
}

/**
 * Cancel the transport/crew side of a job that has just gone lost or cancelled.
 *
 * Idempotent: every UPDATE excludes rows that are already cancelled, so
 * calling it twice (or on a job with nothing on it) is a harmless no-op.
 * Never throws — a failure here must not take down the status change that
 * triggered it. Callers get the counts back for logging.
 */
export async function cascadeJobClose(
  opts: JobCloseCascadeOptions,
): Promise<JobCloseCascadeResult> {
  const { jobId, reason, actorUserId = null } = opts;
  const result: JobCloseCascadeResult = {
    quotesCancelled: 0,
    assignmentsCancelled: 0,
    vehicleAssignmentsCancelled: 0,
    crewEmailed: 0,
  };
  const logTag = `[JobCloseCascade/${reason}]`;

  try {
    const jobResult = await query(
      `SELECT id, hh_job_number, job_name, job_date, job_end
       FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId],
    );
    if (jobResult.rows.length === 0) return result;
    const job = jobResult.rows[0];

    const marker = reason === 'lost' ? LOST_QUOTE_MARKER : CANCELLED_QUOTE_MARKER;

    // Pull crew BEFORE cancelling the assignments, or there's nobody left to
    // email. `is_ooosh_crew = false` drops the "Ooosh Staff" placeholder that
    // local D&C quotes auto-assign — it isn't a real person to notify.
    const crewResult = await query(
      `SELECT DISTINCT qa.role, p.first_name, p.last_name, p.email
         FROM quote_assignments qa
         JOIN people p ON p.id = qa.person_id
         WHERE qa.quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
           AND qa.status NOT IN ('cancelled', 'declined')
           AND qa.is_ooosh_crew = false
           AND p.is_deleted = false
           AND p.email IS NOT NULL
           AND p.email <> ''`,
      [jobId],
    );

    // Quotes. `completed` rows are left alone — the work physically happened
    // and the freelancer is owed for it whatever the parent job's fate.
    // An existing reason is preserved and the marker appended, so nothing a
    // human typed is lost.
    const cancelledQuotes = await query(
      `UPDATE quotes
         SET status = 'cancelled',
             ops_status = 'cancelled',
             status_changed_at = NOW(),
             status_changed_by = $2,
             cancelled_reason = CASE
               WHEN COALESCE(cancelled_reason, '') = '' THEN $3::text
               ELSE cancelled_reason || ' ' || $3::text
             END,
             updated_at = NOW()
       WHERE job_id = $1
         AND is_deleted = false
         AND status NOT IN ('cancelled', 'completed')
       RETURNING id`,
      [jobId, actorUserId, marker],
    );
    result.quotesCancelled = cancelledQuotes.rows.length;

    const cancelledAssignments = await query(
      `UPDATE quote_assignments SET status = 'cancelled', updated_at = NOW()
       WHERE quote_id IN (SELECT id FROM quotes WHERE job_id = $1 AND is_deleted = false)
         AND status NOT IN ('cancelled', 'declined')
       RETURNING id`,
      [jobId],
    );
    result.assignmentsCancelled = cancelledAssignments.rows.length;

    // Vehicle hire assignment sweep. Without this, speculative/orphan rows
    // (derivation-engine pre-allocations, quick-assign, stray booked_out rows)
    // get left behind on a dead job and keep blocking syncFleetHireStatus from
    // transitioning the van to 'Prep Needed'. Dual job match catches V&D-style
    // rows (job_id IS NULL).
    const vhaMarker = reason === 'lost'
      ? '[Auto-cancelled: job marked lost]'
      : '[Auto-cancelled: job cancelled]';
    const sweptVha = await query(
      `UPDATE vehicle_hire_assignments
         SET status = 'cancelled',
             status_changed_at = NOW(),
             notes = COALESCE(notes, '') || E'\n' || $3::text,
             updated_at = NOW()
       WHERE (job_id = $1
              OR (job_id IS NULL AND hirehop_job_id = $2::integer))
         AND status NOT IN ('cancelled', 'returned', 'swapped')
       RETURNING id, vehicle_id`,
      [jobId, job.hh_job_number ?? null, vhaMarker],
    );
    result.vehicleAssignmentsCancelled = sweptVha.rows.length;

    if (sweptVha.rows.length > 0) {
      // Recompute fleet hire_status for each affected vehicle so the cached
      // projection catches up immediately rather than at the next sync.
      const { syncFleetHireStatus } = await import('./fleet-hire-status-sync');
      const seen = new Set<string>();
      for (const r of sweptVha.rows) {
        if (r.vehicle_id && !seen.has(r.vehicle_id)) {
          seen.add(r.vehicle_id);
          try { await syncFleetHireStatus(r.vehicle_id); }
          catch (e) { console.warn(`${logTag} syncFleetHireStatus failed:`, e); }
        }
      }
    }

    // Email crew — only while the job still has work left in it. Every job the
    // stale-enquiry auto-loser touches has finished, so cleaning up historic
    // dead enquiries never spams anyone.
    //
    // Measured against the LATER of job_date and job_end, not the start date.
    // A tour cancelled mid-run has a past start but future days still booked,
    // and that crew very much needs telling. Compare on calendar day to be
    // friendly to timezones.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const candidateDates = [job.job_date, job.job_end]
      .filter(Boolean)
      .map((d) => new Date(d as string | Date))
      .filter((d) => !Number.isNaN(d.getTime()));
    const lastDay = candidateDates.length > 0
      ? new Date(Math.max(...candidateDates.map((d) => d.getTime())))
      : null;
    const isFuture = !!lastDay && lastDay >= today;

    if (isFuture && crewResult.rows.length > 0) {
      const jobNumber = job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW';
      const jobName = job.job_name || 'Untitled';
      const jobDates = [job.job_date, job.job_end].filter(Boolean).map(
        (d: string | Date) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      ).join(' — ');

      for (const crew of crewResult.rows) {
        // Per-recipient guard: one bad address must not stop the rest of the
        // crew being told, and must not abort the cascade's own bookkeeping.
        try {
          await emailService.send('job_cancelled_crew', {
            to: crew.email,
            variables: {
              crewName: `${crew.first_name || ''} ${crew.last_name || ''}`.trim() || 'there',
              jobName,
              jobNumber,
              jobDates,
              crewRole: crew.role || 'Crew',
            },
          });
          result.crewEmailed++;
        } catch (err) {
          console.error(`${logTag} Email failed for ${crew.email}:`, err);
        }
      }
    }

    if (result.quotesCancelled > 0 || result.vehicleAssignmentsCancelled > 0) {
      console.log(
        `${logTag} Job ${jobId}: ${result.quotesCancelled} quote(s), ` +
        `${result.assignmentsCancelled} assignment(s), ` +
        `${result.vehicleAssignmentsCancelled} vehicle assignment(s) cancelled, ` +
        `${result.crewEmailed} crew emailed`,
      );
    }
  } catch (err) {
    // Never let cleanup failure break the status change that triggered it.
    console.error(`${logTag} Cascade failed for job ${jobId}:`, err);
  }

  return result;
}

export interface QuoteReactivationResult {
  reactivatedCount: number;
  ids: string[];
}

/**
 * Reactivate auto-cancelled quotes when a job is resurrected (moved back out
 * of lost/cancelled). Mirrors `reactivateAutoCancelledRequirements`.
 *
 * Marker-gated — a quote a human cancelled has no marker and stays cancelled.
 *
 * Quotes come back as `draft` / `todo`, NOT at whatever status they held
 * before. Two reasons: the prior status isn't recorded anywhere, and the crew
 * assignments deliberately stay cancelled (see below), so a quote restored
 * straight to `confirmed` would claim crew it no longer has.
 *
 * Crew assignments are deliberately NOT reinstated. Those freelancers were
 * emailed "this job is off" — silently putting them back on it would imply a
 * commitment nobody made to them. Re-offering is a human decision.
 * Vehicle hire assignments likewise stay cancelled: an unallocated van is the
 * safe direction, and staff re-allocate from the Allocations screen.
 */
export async function reactivateAutoCancelledQuotes(
  jobId: string,
): Promise<QuoteReactivationResult> {
  const result = await query(
    `UPDATE quotes
     SET status = 'draft',
         ops_status = 'todo',
         status_changed_at = NOW(),
         cancelled_reason = NULL,
         updated_at = NOW()
     WHERE job_id = $1
       AND is_deleted = false
       AND status = 'cancelled'
       AND (cancelled_reason LIKE '%' || $2::text || '%'
            OR cancelled_reason LIKE '%' || $3::text || '%'
            OR cancelled_reason = $4::text
            OR cancelled_reason = $5::text)
     RETURNING id`,
    [jobId, LOST_QUOTE_MARKER, CANCELLED_QUOTE_MARKER, LEGACY_LOST_REASON, LEGACY_CANCELLED_REASON],
  );
  return {
    reactivatedCount: result.rows.length,
    ids: result.rows.map((r: { id: string }) => r.id),
  };
}
