/**
 * Vehicle lifecycle email helpers.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from './money-emails';

/**
 * Notify the client that the vehicle on their hire has changed (vehicle swap).
 * Fires best-effort from the swap endpoint for BOTH kinds:
 *  - planned: confirms the arranged change (e.g. an upgrade)
 *  - breakdown: informs them their van was changed
 * Routed through resolveClientEmailTarget (job_contacts → address book → info@
 * fallback with banner). Skipped for internal jobs (garage runs etc. — no
 * client). Never throws; the swap's durable record is the DB + Job Issue.
 */
export async function sendVehicleSwappedEmail(opts: {
  jobId: string; // OP job UUID
  newReg: string;
  oldReg?: string | null;
  planned: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  const { jobId, newReg, oldReg, planned } = opts;
  try {
    const jobRow = await query(
      `SELECT COALESCE(is_internal, false) AS is_internal FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (jobRow.rows.length === 0) return { sent: false, reason: 'no_job' };
    if (jobRow.rows[0].is_internal) return { sent: false, reason: 'internal_job' };

    const target = await resolveClientEmailTarget(jobId, 'vehicle_swapped');
    const res = await emailService.send('vehicle_swapped', {
      to: target.primaryEmail,
      cc: target.ccEmails.length > 0 ? target.ccEmails : undefined,
      prependBanner: target.isFallback
        ? buildFallbackBanner({
            jobId,
            clientName: target.clientName,
            jobNumber: target.jobNumber,
            jobName: target.jobName,
          })
        : undefined,
      variables: {
        clientName: target.primaryFirstName || target.clientName || 'there',
        jobName: target.jobName || `Job #${target.jobNumber || ''}`,
        jobNumber: target.jobNumber || '',
        newReg,
        oldReg: oldReg || '',
        // Complementary flags — the template engine has no {{else}}, so we
        // drive the two intro variants with mutually-exclusive {{#if}} blocks.
        planned: planned ? 'yes' : '',
        unplanned: planned ? '' : 'yes',
      },
    });
    if (!res.success) return { sent: false, reason: 'error' };
    if (target.isFallback) await logFallbackToTimeline({ jobId, templateId: 'vehicle_swapped' });
    return { sent: true };
  } catch (err) {
    console.warn('[vehicle-emails] vehicle_swapped send failed:', err instanceof Error ? err.message : err);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Build + send the "marked Returned but vans still booked out" safety-net
 * email. Used by the scheduled scanner (services/returned-bookedout-scanner.ts
 * + config/scheduler.ts) — not the inline webhook/pipeline call sites
 * any more.
 *
 * Why scheduled rather than inline: HH fires the webhook the moment HH
 * flips to Returned (6→7), but OP-side check-in (physical, per van, all
 * driver rows on a van flip together) often happens at the desk minutes
 * later. The inline send-as-soon-as-HH-says-returned trigger generated
 * false-positive emails for staff who were about to do the check-in
 * anyway. The scanner sweeps after a 20-min grace window, by which point
 * any real desk-side check-in has happened and the warning is genuinely
 * worth surfacing.
 *
 * De-dupe by vehicle: a multi-driver hire on one van produces N
 * `vehicle_hire_assignments` rows with the SAME `vehicle_id` (per the
 * documented data model). The pre-refactor code counted those rows
 * literally, producing "3 van(s) still booked out — RX73TCJ, RX73TCJ,
 * RX73TCJ" for a single hire with three drivers. Grouped query below
 * collapses to one entry per van and surfaces driver count as a suffix
 * when > 1.
 */
export async function buildAndSendReturnedBookedOutAlert(opts: {
  jobId: string;
  triggerSource: string;
}): Promise<{ sent: boolean; vanCount: number }> {
  const { jobId, triggerSource } = opts;

  // Group by vehicle so a multi-driver hire on one van counts as ONE.
  // Rows with no vehicle_id (unassigned slot placeholders) bucket
  // separately under (unassigned) so we don't silently hide them.
  const grouped = await query(
    `SELECT vha.vehicle_id,
            COALESCE(fv.reg, '(unassigned)') AS vehicle_reg,
            COUNT(*) AS driver_count
     FROM vehicle_hire_assignments vha
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     WHERE vha.job_id = $1
       AND vha.status IN ('booked_out', 'active')
     GROUP BY vha.vehicle_id, fv.reg
     ORDER BY fv.reg NULLS LAST`,
    [jobId]
  );

  if (grouped.rows.length === 0) {
    return { sent: false, vanCount: 0 };
  }

  const jobResult = await query(
    `SELECT job_name, hh_job_number FROM jobs WHERE id = $1`,
    [jobId]
  );
  const job = jobResult.rows[0];
  if (!job) return { sent: false, vanCount: 0 };

  // Render "RX73TCJ (3 drivers)" per van — only suffix the driver-count
  // when > 1 so single-driver hires read naturally.
  const vanList = grouped.rows
    .map((r: { vehicle_reg: string; driver_count: number | string }) => {
      const count = Number(r.driver_count);
      return count > 1 ? `${r.vehicle_reg} (${count} drivers)` : r.vehicle_reg;
    })
    .join(', ');

  const vanCount = grouped.rows.length;
  const frontendUrl = getFrontendUrl();

  const result = await emailService.send('job_returned_vans_still_out', {
    to: 'info@oooshtours.co.uk',
    variables: {
      jobNumber: String(job.hh_job_number || ''),
      jobName: job.job_name || `Job #${job.hh_job_number || ''}`,
      vanCount: String(vanCount),
      vanList,
      triggerSource,
      jobUrl: `${frontendUrl}/jobs/${jobId}`,
    },
  });

  if (result.success) {
    console.log(`[vehicle-emails] returned-gate alert sent for job ${jobId}: ${vanList}`);
  } else {
    console.warn(`[vehicle-emails] returned-gate alert failed for job ${jobId}:`, result);
  }

  return { sent: result.success === true, vanCount };
}

/**
 * Back-compat shim for the legacy inline call sites on webhooks.ts and
 * pipeline.ts. No-op now — the scanner handles this after a grace
 * window. Kept as a public export so existing imports don't break in
 * this PR; deletion of the call sites + this shim is a follow-up.
 */
export async function alertReturnedWithStillBookedOutVans(opts: {
  jobId: string;
  triggerSource: string;
}): Promise<void> {
  void opts;
}
