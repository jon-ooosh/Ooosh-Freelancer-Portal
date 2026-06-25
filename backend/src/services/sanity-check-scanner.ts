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
 *   • runBookedOutNoTimestampScan — tripwire for `vehicle_hire_assignments`
 *     stuck at booked_out with `booked_out_at IS NULL` for >3h. Should be
 *     impossible post the Jun 2026 book-out fix; a hit signals a regression
 *     that reintroduced a timestamp-less book-out (the RX73TBZ 16057↔16149
 *     mis-attribution state). One alert per job, deduped via a notes marker.
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

/**
 * Tripwire: vehicle_hire_assignments stuck at status='booked_out' with
 * booked_out_at NULL for > 3 hours.
 *
 * Since the Jun 2026 book-out fix (hire-forms PATCH stamps booked_out_at on
 * every booked_out transition) this state should be IMPOSSIBLE. A hit means a
 * code path has regressed and reintroduced a timestamp-less book-out — the
 * exact state that fools the check-in job-resolver into picking a stale
 * book-out from a previous hire and silently strands the real one (RX73TBZ,
 * jobs 16057↔16149). This catches it in hours instead of days.
 *
 * One alert per job (multi-driver hires share a van). Dedup via a notes
 * marker — consistent with this table's other row-level markers
 * ([Suspended: …], [Auto-cancelled: …]) — so no migration is needed. The
 * 3-hour grace is generous: a legitimate book-out gets booked_out_at stamped
 * synchronously in the PATCH, so nothing real should ever linger this long.
 * Stamp-first, like the scanners above.
 */
const NO_TS_MARKER = '[Tripwire: booked_out missing timestamp — alerted]';

export async function runBookedOutNoTimestampScan(): Promise<{ checked: number; warned: number }> {
  const candidates = await query(
    `SELECT vha.id, vha.hirehop_job_id, fv.reg
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.status = 'booked_out'
        AND vha.booked_out_at IS NULL
        AND vha.status_changed_at < NOW() - INTERVAL '3 hours'
        AND (vha.notes IS NULL OR vha.notes NOT LIKE $1)
      ORDER BY vha.status_changed_at ASC
      LIMIT 100`,
    [`%${NO_TS_MARKER}%`]
  );

  if (candidates.rows.length === 0) return { checked: 0, warned: 0 };

  // Group rows per job so a multi-driver hire produces one alert, not N.
  const byJob = new Map<string, { reg: string | null; rowIds: string[] }>();
  for (const r of candidates.rows) {
    const key = r.hirehop_job_id != null ? String(r.hirehop_job_id) : `unlinked:${r.id}`;
    if (!byJob.has(key)) byJob.set(key, { reg: r.reg, rowIds: [] });
    byJob.get(key)!.rowIds.push(r.id);
  }

  let warned = 0;

  for (const [jobKey, info] of byJob) {
    try {
      // Stamp the marker on every row in the group FIRST — same stamp-first
      // rationale as the scanners above (a transient send failure must not
      // re-fire on the next scan).
      await query(
        `UPDATE vehicle_hire_assignments
            SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2
                             ELSE notes || E'\\n' || $2 END,
                updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [info.rowIds, NO_TS_MARKER]
      );

      const hhJob = jobKey.startsWith('unlinked:') ? null : jobKey;
      const jobRef = hhJob ? `HH #${hhJob}` : '(no HH job linked)';
      const regLabel = info.reg || '(no vehicle linked)';
      const hhJobUrl = hhJob ? `https://myhirehop.com/job.php?id=${hhJob}` : '';

      const html = `
        <p><strong>Data-integrity tripwire: book-out with no timestamp.</strong></p>
        <p>${info.rowIds.length} hire assignment row(s) on <strong>${jobRef}</strong>
        (vehicle <strong>${regLabel}</strong>) are <code>status='booked_out'</code> but
        <code>booked_out_at IS NULL</code>, and have been for over 3 hours.</p>
        <p>Since the Jun 2026 book-out fix this should be impossible. A hit means a
        code path has regressed and reintroduced a timestamp-less book-out — the
        state that lets a check-in mis-attribute a hire to the wrong job
        (RX73TBZ / 16057↔16149). Please investigate the affected book-out flow.</p>
        ${hhJobUrl ? `<p><a href="${hhJobUrl}">Open job in HireHop</a></p>` : ''}
        <p style="color:#888;font-size:12px">Sanity scanner — 3-hour booked_out-without-timestamp check.</p>
      `;

      const result = await emailService.sendRaw({
        to: 'info@oooshtours.co.uk',
        subject: `⚠ Book-out with no timestamp — ${jobRef} (${regLabel})`,
        html,
      });
      if (result.success) warned++;
      else console.warn(`[sanity-scanner] booked_out-no-ts alert send failed for ${jobRef}:`, result);
    } catch (err) {
      console.error(`[sanity-scanner] booked_out-no-ts scan error for job ${jobKey}:`, err);
    }
  }

  return { checked: candidates.rows.length, warned };
}
