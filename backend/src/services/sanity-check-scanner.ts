/**
 * Sanity-check scanners — dispatch + return.
 *
 * Two related scanners, both deferred + de-duped:
 *
 *   • runDispatchSanityScan — finds jobs at pipeline_status='dispatched'
 *     whose HH `status` column is still < 5 after a 30-min grace window
 *     (one full polling-sync cycle, so the cached HH copy has had time to
 *     refresh). Fires ONCE per dispatch via
 *     `jobs.under_dispatch_warned_at` and pushes the warning to info@.
 *
 *   • runReturnedBookedOutScan — finds jobs at pipeline_status='returned'
 *     that still have `vehicle_hire_assignments` rows in booked_out/active
 *     after a 20-min grace. Fires ONCE per transition into 'returned' via
 *     `jobs.returned_bookedout_warned_at`. Email is built by
 *     `buildAndSendReturnedBookedOutAlert` (de-dupes drivers per van).
 *
 * Both markers are cleared on transitions out of their respective
 * pipeline_status so a re-entered state can warn afresh — handled in
 * routes/pipeline.ts and routes/webhooks.ts wherever pipeline_status
 * transitions are written.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { HH_STATUS_LABELS } from './auto-dispatch';
import { buildAndSendReturnedBookedOutAlert } from './vehicle-emails';

/**
 * Find dispatched jobs whose HH status is still pre-Dispatched (< 5)
 * after a 30-min grace window. Sends one warning per job, stamps marker.
 */
export async function runDispatchSanityScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT id, hh_job_number, job_name, status, pipeline_status_changed_at
     FROM jobs
     WHERE pipeline_status = 'dispatched'
       AND status IS NOT NULL
       AND status < 5
       AND under_dispatch_warned_at IS NULL
       AND pipeline_status_changed_at IS NOT NULL
       AND pipeline_status_changed_at < NOW() - INTERVAL '30 minutes'
       AND is_deleted = false
     ORDER BY pipeline_status_changed_at ASC
     LIMIT 50`
  );

  let warned = 0;
  const frontendUrl = getFrontendUrl();

  for (const job of candidates.rows) {
    try {
      const hhStatus: number = job.status;
      const hhStatusLabel = HH_STATUS_LABELS[hhStatus] || `Status ${hhStatus}`;
      const jobRef = job.hh_job_number
        ? `J-${job.hh_job_number}`
        : (job.job_name || 'Unknown job');
      const opJobUrl = `${frontendUrl}/jobs/${job.id}`;
      const hhJobUrl = job.hh_job_number
        ? `https://myhirehop.com/job.php?id=${job.hh_job_number}`
        : '';

      // Stamp the marker FIRST so a transient send-failure doesn't cause
      // the next scan to re-fire. The cost is "one rare email that
      // didn't actually send" vs "duplicate emails on every scan if a
      // template/SMTP issue persists" — the latter is the spam pattern
      // we're trying to eliminate, so stamp-first wins.
      await query(
        `UPDATE jobs SET under_dispatch_warned_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      const result = await emailService.send('under_dispatched_warning', {
        to: 'info@oooshtours.co.uk',
        variables: {
          jobRef,
          jobName: job.job_name || '',
          jobNumber: job.hh_job_number ? String(job.hh_job_number) : '',
          source: 'Sanity scanner (30-min post-dispatch check)',
          actorLabel: 'scheduler',
          hhStatusLabel,
          hhStatusCode: String(hhStatus),
          opJobUrl,
          hhJobUrl,
        },
      });

      if (result.success) {
        warned++;
      } else {
        console.warn(`[sanity-scanner] dispatch warning send failed for ${jobRef}:`, result);
      }
    } catch (err) {
      console.error(`[sanity-scanner] dispatch scan error for job ${job.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}

/**
 * Find returned jobs that still have booked_out/active assignment rows
 * after a 20-min grace window. Sends one de-duped-by-vehicle warning
 * per job, stamps marker.
 */
export async function runReturnedBookedOutScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT j.id
     FROM jobs j
     WHERE j.pipeline_status = 'returned'
       AND j.returned_bookedout_warned_at IS NULL
       AND j.pipeline_status_changed_at IS NOT NULL
       AND j.pipeline_status_changed_at < NOW() - INTERVAL '20 minutes'
       AND j.is_deleted = false
       AND EXISTS (
         SELECT 1 FROM vehicle_hire_assignments vha
         WHERE vha.job_id = j.id
           AND vha.status IN ('booked_out', 'active')
       )
     ORDER BY j.pipeline_status_changed_at ASC
     LIMIT 50`
  );

  let warned = 0;

  for (const job of candidates.rows) {
    try {
      // Stamp BEFORE sending — see rationale in dispatch scanner above.
      await query(
        `UPDATE jobs SET returned_bookedout_warned_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      const result = await buildAndSendReturnedBookedOutAlert({
        jobId: job.id,
        triggerSource: 'Sanity scanner (20-min post-return check)',
      });
      if (result.sent) warned++;
    } catch (err) {
      console.error(`[sanity-scanner] returned-bookedout scan error for job ${job.id}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}
