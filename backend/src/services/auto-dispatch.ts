/**
 * Auto-dispatch helper.
 *
 * Centralises the "flip OP pipeline_status to dispatched + writeback HH +
 * log timeline interaction" pattern that fires from three places:
 *   - Warehouse customer-collection (warehouse.ts)
 *   - Freelancer portal completion of last delivery (portal.ts)
 *   - Staff in-person book-out (hire-forms.ts PATCH)
 *
 * The dispatch sanity check (warning when HH status hasn't caught up to 5)
 * used to fire inline from here on every call, which (a) re-fired for every
 * driver/van on a multi-driver job, and (b) tripped false positives while
 * the synced `jobs.status` was stale relative to live HireHop.
 *
 * Replaced May 2026 by a 15-min scheduler scan (config/scheduler.ts) that
 * runs ~30 min after dispatch, by which time the local copy has caught up
 * via the 30-min polling sync. The scanner uses `jobs.under_dispatch_warned_at`
 * (migration 102) as a dedup marker so at most ONE warning fires per
 * dispatch. We also clear the marker on transition out of `dispatched`
 * (e.g. on return) so a re-dispatched job can warn afresh.
 */
import { query } from '../config/database';
import { writeBackStatusToHireHop } from './hirehop-writeback';

export interface AutoDispatchOptions {
  /** OP job UUID */
  jobId: string;
  /** Source path — used in the audit interaction + email subject */
  source: 'warehouse' | 'portal' | 'staff-bookout';
  /**
   * Human-readable label of who triggered this — staff name, freelancer name,
   * "warehouse PIN", etc. Goes into the timeline interaction + writeback log.
   */
  actorLabel: string;
  /**
   * Optional UUID of the OP user who triggered this. When provided, a bell
   * notification is created on under-dispatch sanity-check fires. Pass null
   * for non-staff actors (warehouse PIN, portal freelancer).
   */
  actorUserId?: string | null;
  /** Free-text content for the timeline interaction (the icon + summary line) */
  interactionContent: string;
}

export interface AutoDispatchResult {
  /** Did we flip OP from non-dispatched to dispatched on this call? */
  opStatusChanged: boolean;
  /** HH writeback outcome */
  hhWriteback: { success: boolean; message: string };
  /** Did we fire the under-dispatched warning email? */
  underDispatchedWarningFired: boolean;
  /** HH status (integer) at the time of the check, for callers who want to log/return it */
  hhStatusAtCheck: number | null;
}

/**
 * Run the dispatch flip with sanity check. Idempotent: if `pipeline_status`
 * is already `dispatched`, no flip / no interaction / no warning email; just
 * a writeback (which itself is idempotent — skips if HH already at 5).
 */
export async function autoDispatchJob(opts: AutoDispatchOptions): Promise<AutoDispatchResult> {
  const result: AutoDispatchResult = {
    opStatusChanged: false,
    hhWriteback: { success: true, message: 'No HH writeback attempted' },
    underDispatchedWarningFired: false,
    hhStatusAtCheck: null,
  };

  const jobRow = await query(
    `SELECT id, hh_job_number, job_name, pipeline_status, status
     FROM jobs WHERE id = $1`,
    [opts.jobId]
  );
  const job = jobRow.rows[0];
  if (!job) {
    console.warn(`[auto-dispatch] Job ${opts.jobId} not found — skipping.`);
    return result;
  }

  result.hhStatusAtCheck = job.status;

  // Sanity-check email moved to scheduled scanner (config/scheduler.ts +
  // services/under-dispatch-scanner.ts) — see header comment.
  // result.underDispatchedWarningFired stays false here; the scanner
  // marks `jobs.under_dispatch_warned_at` instead.

  // ── OP flip: confirmed/prepped/prepping → dispatched.
  // Whitelist guard so we never regress a job past dispatch. Idempotent:
  // already-dispatched jobs no-op here.
  if (['confirmed', 'prepped', 'prepping'].includes(job.pipeline_status)) {
    await query(
      `UPDATE jobs SET pipeline_status = 'dispatched',
                       pipeline_status_changed_at = NOW(),
                       updated_at = NOW()
       WHERE id = $1`,
      [opts.jobId]
    );
    result.opStatusChanged = true;

    try {
      await query(
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
         VALUES ('note', $1, $2, $3, 'dispatched', 'system')`,
        [
          opts.interactionContent,
          opts.jobId,
          opts.actorUserId || SYSTEM_USER_ID,
        ]
      );
    } catch (err) {
      console.error('[auto-dispatch] interaction insert error:', err);
    }
  }

  // ── HH writeback: push to status 5. Idempotent — writeback skips when
  // HH is already at the target status.
  if (job.hh_job_number) {
    try {
      result.hhWriteback = await writeBackStatusToHireHop(
        opts.jobId,
        'dispatched',
        `${opts.source}:${opts.actorLabel}`
      );
    } catch (err) {
      console.error('[auto-dispatch] HH writeback error:', err);
      result.hhWriteback = { success: false, message: String(err) };
    }
  }

  return result;
}

// System user UUID (migration 031) — used for non-user-attributed interactions.
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Public HH-status integer → human label map. Used by the dispatch sanity
 *  scanner when composing the warning email. */
export const HH_STATUS_LABELS: Record<number, string> = {
  0: '0 — Enquiry',
  1: '1 — Provisional',
  2: '2 — Booked',
  3: '3 — Prepped',
  4: '4 — Part Dispatched',
  5: '5 — Dispatched',
  6: '6 — Returned Incomplete',
  7: '7 — Returned',
  8: '8 — Requires Attention',
  9: '9 — Cancelled',
  10: '10 — Not Interested',
  11: '11 — Completed',
};
