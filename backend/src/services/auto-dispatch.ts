/**
 * Auto-dispatch helper.
 *
 * Centralises the "flip OP pipeline_status to dispatched + writeback HH +
 * log timeline interaction" pattern that fires from three places:
 *   - Warehouse customer-collection (warehouse.ts)
 *   - Freelancer portal completion of last delivery (portal.ts)
 *   - Staff in-person book-out (hire-forms.ts PATCH)
 *
 * Adds a sanity check: before flipping OP, if HireHop status (synced
 * `jobs.status` integer) is < 5 (not yet Dispatched in HH — i.e. still
 * Booked / Prepped / Part Dispatched / earlier), fire a warning email
 * to info@ + a bell notification to the acting user explaining that the
 * job is being marked On Hire in OP while not all items are dispatched
 * in HH. Then proceed with the flip + writeback regardless — the email
 * is informational, not blocking.
 */
import { query } from '../config/database';
import { writeBackStatusToHireHop } from './hirehop-writeback';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

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

  // ── Sanity check: HH status < 5 (anything pre-Dispatched, including
  // Part Dispatched 4) → warning email + bell notification.
  // Fires regardless of OP state — covers retries where the pipeline is
  // already 'dispatched' but HH never moved (the original under-dispatch).
  const hhStatus: number | null = job.status;
  if (hhStatus !== null && hhStatus < 5) {
    result.underDispatchedWarningFired = true;
    const frontendUrl = getFrontendUrl();
    const opJobUrl = `${frontendUrl}/jobs/${opts.jobId}`;
    const hhJobUrl = job.hh_job_number
      ? `https://myhirehop.com/job.php?id=${job.hh_job_number}`
      : '';
    const hhStatusLabel = HH_STATUS_LABELS[hhStatus] || `Status ${hhStatus}`;
    const jobRef = job.hh_job_number
      ? `J-${job.hh_job_number}`
      : (job.job_name || 'Unknown job');

    // Email to info@ — non-blocking, log on failure
    try {
      await emailService.send('under_dispatched_warning', {
        to: 'info@oooshtours.co.uk',
        variables: {
          jobRef,
          jobName: job.job_name || '',
          source: SOURCE_LABELS[opts.source],
          actorLabel: opts.actorLabel,
          hhStatusLabel,
          hhStatusCode: String(hhStatus),
          opJobUrl,
          hhJobUrl,
        },
      });
    } catch (err) {
      console.error('[auto-dispatch] under-dispatched warning email failed:', err);
    }

    // Bell notification to acting user (if staff JWT — warehouse PIN /
    // portal freelancers won't have a user_id and skip this).
    if (opts.actorUserId) {
      try {
        await query(
          `INSERT INTO notifications (user_id, type, priority, title, content,
                                       entity_type, entity_id, action_url)
           VALUES ($1, 'system', 'high', $2, $3, 'jobs', $4, $5)`,
          [
            opts.actorUserId,
            `${jobRef}: marked On Hire but HH not fully dispatched`,
            `You just marked ${jobRef} as On Hire, but HireHop status is still "${hhStatusLabel}". Some items may not be dispatched in HH. Please confirm.`,
            opts.jobId,
            opJobUrl,
          ]
        );
      } catch (err) {
        console.warn('[auto-dispatch] bell notification insert failed:', err);
      }
    }
  }

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
        `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation)
         VALUES ('note', $1, $2, $3, 'dispatched')`,
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

const HH_STATUS_LABELS: Record<number, string> = {
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

const SOURCE_LABELS: Record<AutoDispatchOptions['source'], string> = {
  warehouse: 'Warehouse customer collection',
  portal: 'Freelancer portal completion',
  'staff-bookout': 'Staff in-person book-out',
};

// System user UUID (migration 031) — used for non-user-attributed interactions.
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
