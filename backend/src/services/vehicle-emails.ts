/**
 * Vehicle lifecycle email helpers.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

/**
 * Safety-net alert: a job has just been flipped to pipeline_status='returned'
 * (from HH webhook, manual UI, or otherwise) while one or more per-van
 * `vehicle_hire_assignments` rows are still in `booked_out` state.
 *
 * Fires once per transition INTO 'returned' (the caller guards against
 * repeat triggers). Non-blocking — just emails info@ so staff spot the
 * mismatch and either physically check the vans in or roll the status back.
 */
export async function alertReturnedWithStillBookedOutVans(opts: {
  jobId: string;
  triggerSource: string;
}): Promise<void> {
  try {
    const { jobId, triggerSource } = opts;

    const openAssignments = await query(
      `SELECT vha.id, vha.hirehop_job_id,
              fv.reg AS vehicle_reg
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       WHERE vha.job_id = $1
         AND vha.status IN ('booked_out', 'active')`,
      [jobId]
    );

    if (openAssignments.rows.length === 0) return;

    const jobResult = await query(
      `SELECT job_name, hh_job_number FROM jobs WHERE id = $1`,
      [jobId]
    );
    const job = jobResult.rows[0];
    if (!job) return;

    const regs = openAssignments.rows
      .map(r => r.vehicle_reg || '(unassigned)')
      .join(', ');
    const frontendUrl = getFrontendUrl();

    const result = await emailService.send('job_returned_vans_still_out', {
      to: 'info@oooshtours.co.uk',
      variables: {
        jobNumber: String(job.hh_job_number || ''),
        jobName: job.job_name || `Job #${job.hh_job_number || ''}`,
        vanCount: String(openAssignments.rows.length),
        vanList: regs,
        triggerSource,
        jobUrl: `${frontendUrl}/jobs/${jobId}`,
      },
    });

    if (result.success) {
      console.log(`[vehicle-emails] returned-gate alert sent for job ${jobId}: ${regs}`);
    } else {
      console.warn(`[vehicle-emails] returned-gate alert failed for job ${jobId}:`, result);
    }
  } catch (err) {
    console.error(`[vehicle-emails] returned-gate alert error for job ${opts.jobId}:`, err);
  }
}
