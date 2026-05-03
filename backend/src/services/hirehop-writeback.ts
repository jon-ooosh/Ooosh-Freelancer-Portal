/**
 * HireHop Write-Back Service
 *
 * Pushes status changes FROM Ooosh back TO HireHop.
 * Uses the broker for rate limiting and the `no_webhook=1` flag to prevent loops.
 *
 * Pipeline status → HireHop status mapping:
 *   new_enquiry / chasing / paused  → 0 (Enquiry)
 *   provisional                     → 1 (Provisional)
 *   confirmed                       → 2 (Booked)
 *   lost                            → 10 (Not Interested)
 *   cancelled                       → 9 (Cancelled)
 */
import { hhBroker } from './hirehop-broker';
import { query } from '../config/database';

// ── Pipeline → HireHop status mapping ────────────────────────────────────

const PIPELINE_TO_HH: Record<string, number> = {
  new_enquiry: 0,
  quoting: 0,
  chasing: 0,
  paused: 0,
  provisional: 1,
  confirmed: 2,
  lost: 10,        // Not Interested
  cancelled: 9,    // Cancelled (distinct from lost)
  // Operational statuses
  prepping: 4,     // Part Dispatched — prep in progress (some items scanned)
  prepped: 3,
  // dispatched (On Hire) maps to HH 5. Usually a no-op because HH auto-jumps
  // to 5 on physical checkout, but warehouse / staff-initiated dispatches need
  // to push (e.g. customer-collect sign-off where OP is the origin of the
  // dispatch event, not HH). The "skip if already at target" guard below
  // means redundant pushes are silent no-ops.
  dispatched: 5,
  returned_incomplete: 6,
  returned: 7,
  completed: 11,
};

// HireHop → Pipeline status mapping (for inbound webhooks).
// Note: outbound (PIPELINE_TO_HH) is intentionally less rich — OP 'dispatched'
// doesn't push to HH because HH auto-jumps to 5 on physical checkout, and
// 'returned_incomplete' pushes to HH 6 not 8. The HH integer is preserved in
// jobs.status so no information is lost.
export const HH_TO_PIPELINE: Record<number, string> = {
  0: 'new_enquiry',
  1: 'provisional',
  2: 'confirmed',
  3: 'prepped',
  4: 'prepping',   // Part Dispatched → Prepping (some items scanned, prep in progress)
  5: 'prepped',    // HH skips to Dispatched(5) on checkout — OP treats as Prepped, staff clicks "On Hire" separately
  6: 'returned_incomplete',
  7: 'returned',
  8: 'returned_incomplete', // Requires Attention — "returned with problems" semantically maps to incomplete; HH integer preserved in jobs.status for richer UI distinction if needed
  9: 'cancelled',  // HH Cancelled → OP cancelled
  10: 'lost',      // Not Interested → lost
  11: 'completed',
};

/**
 * Push a pipeline status change to HireHop.
 *
 * @param jobId - Ooosh job UUID
 * @param pipelineStatus - new Ooosh pipeline status
 * @param triggeredBy - who triggered this (for logging)
 * @returns true if write-back succeeded, false otherwise
 */
export async function writeBackStatusToHireHop(
  jobId: string,
  pipelineStatus: string,
  triggeredBy: string,
): Promise<{ success: boolean; message: string }> {
  // Get the HireHop job number
  const jobResult = await query(
    `SELECT hh_job_number, status as current_hh_status FROM jobs WHERE id = $1`,
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    return { success: false, message: 'Job not found' };
  }

  const { hh_job_number, current_hh_status } = jobResult.rows[0];

  if (!hh_job_number) {
    // Job was created in Ooosh without a HireHop link — no write-back needed
    return { success: true, message: 'No HireHop job linked — skipped' };
  }

  const targetHHStatus = PIPELINE_TO_HH[pipelineStatus];
  if (targetHHStatus === undefined) {
    return { success: false, message: `No HireHop mapping for pipeline status: ${pipelineStatus}` };
  }

  // Don't write back if HH status is already correct
  if (current_hh_status === targetHHStatus) {
    return { success: true, message: `HireHop already at status ${targetHHStatus} — skipped` };
  }

  // Block writing back to HH for status 4 (Part Dispatched) — that's HH-internal
  if (current_hh_status === 4) {
    return { success: false, message: `Job is in HH-managed status ${current_hh_status} (Part Dispatched) — write-back blocked` };
  }

  try {
    // POST to HireHop status_save.php with no_webhook=1 to prevent loops
    const result = await hhBroker.post('/frames/status_save.php', {
      job: hh_job_number,
      status: targetHHStatus,
      no_webhook: 1,
    }, { priority: 'high' });

    if (result.success) {
      // Update our local hh_status to reflect the change
      await query(
        `UPDATE jobs SET status = $1, status_name = $2, hh_status = $1, updated_at = NOW() WHERE id = $3`,
        [targetHHStatus, getHHStatusName(targetHHStatus), jobId],
      );

      console.log(`[HH Write-back] Job ${hh_job_number}: status → ${targetHHStatus} (${getHHStatusName(targetHHStatus)}) triggered by ${triggeredBy}`);
      return { success: true, message: `HireHop updated to ${getHHStatusName(targetHHStatus)}` };
    } else {
      console.error(`[HH Write-back] Failed for job ${hh_job_number}:`, result.error);
      return { success: false, message: `HireHop API error: ${result.error}` };
    }
  } catch (err) {
    console.error(`[HH Write-back] Exception for job ${hh_job_number}:`, err);
    return { success: false, message: `Write-back exception: ${err}` };
  }
}

function getHHStatusName(status: number): string {
  const names: Record<number, string> = {
    0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
    4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
    7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
    10: 'Not Interested', 11: 'Completed',
  };
  return names[status] || `Unknown (${status})`;
}

/**
 * Push a job name change to HireHop.
 *
 * Without this, the 30-min HH job sync (which unconditionally overwrites
 * `jobs.job_name` from HireHop's JOB_NAME) clobbers any rename the user
 * made in OP. We push to HH so both sides agree.
 *
 * @param jobId - Ooosh job UUID
 * @param newJobName - the new job name (already trimmed/validated)
 * @param triggeredBy - who triggered this (for logging)
 * @returns success/message; non-success does NOT throw — caller decides whether to surface
 */
export async function writeBackJobNameToHireHop(
  jobId: string,
  newJobName: string,
  triggeredBy: string,
): Promise<{ success: boolean; message: string }> {
  const jobResult = await query(
    `SELECT hh_job_number FROM jobs WHERE id = $1`,
    [jobId],
  );

  if (jobResult.rows.length === 0) {
    return { success: false, message: 'Job not found' };
  }

  const { hh_job_number } = jobResult.rows[0];

  if (!hh_job_number) {
    return { success: true, message: 'No HireHop job linked — skipped' };
  }

  try {
    const result = await hhBroker.post('/api/save_job.php', {
      job: hh_job_number,
      job_name: newJobName,
      no_webhook: 1,
    }, { priority: 'high' });

    if (result.success) {
      console.log(`[HH Write-back] Job ${hh_job_number}: name → "${newJobName}" triggered by ${triggeredBy}`);
      return { success: true, message: 'HireHop job name updated' };
    } else {
      console.error(`[HH Write-back] Name update failed for job ${hh_job_number}:`, result.error);
      return { success: false, message: `HireHop API error: ${result.error}` };
    }
  } catch (err) {
    console.error(`[HH Write-back] Exception updating name for job ${hh_job_number}:`, err);
    return { success: false, message: `Write-back exception: ${err}` };
  }
}
