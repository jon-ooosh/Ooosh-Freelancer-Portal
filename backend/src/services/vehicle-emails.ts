/**
 * Vehicle lifecycle email helpers.
 *
 * Keeps the recipient resolution + template variable assembly in one place
 * so both the OP assignment endpoints and the legacy vehicle-event save
 * path fire the same emails with the same semantics.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from './money-emails';
import { getFrontendUrl } from '../config/app-urls';

/**
 * Send the "vehicle checked in" confirmation to the client contacts on a job.
 *
 * Idempotent at the JOB level — if any of the job's assignments already has
 * `checked_in_at` set (i.e. we've already run check-in for this van/job),
 * we skip sending. The caller is responsible for setting `checked_in_at`
 * BEFORE invoking this so subsequent check-ins on the same job don't
 * re-spam the client.
 */
export async function sendVehicleCheckedInEmail(assignmentId: string): Promise<void> {
  try {
    const assignmentResult = await query(
      `SELECT vha.job_id, vha.checked_in_at,
              fv.reg AS vehicle_reg
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       WHERE vha.id = $1`,
      [assignmentId]
    );
    if (assignmentResult.rows.length === 0) {
      console.warn(`[vehicle-emails] check-in: assignment ${assignmentId} not found`);
      return;
    }
    const assignment = assignmentResult.rows[0];
    const jobId = assignment.job_id;
    const vehicleReg = assignment.vehicle_reg;

    if (!jobId) {
      console.warn(`[vehicle-emails] check-in: assignment ${assignmentId} has no job_id; skipping email`);
      return;
    }
    if (!vehicleReg) {
      console.warn(`[vehicle-emails] check-in: assignment ${assignmentId} has no vehicle_reg; skipping email`);
      return;
    }

    const jobResult = await query(
      `SELECT job_name, hh_job_number FROM jobs WHERE id = $1`,
      [jobId]
    );
    const job = jobResult.rows[0];
    if (!job) {
      console.warn(`[vehicle-emails] check-in: job ${jobId} not found for assignment ${assignmentId}`);
      return;
    }

    const target = await resolveClientEmailTarget(jobId);

    const returnedAt = new Date().toLocaleString('en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
    });

    const result = await emailService.send('vehicle_checked_in', {
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
        clientName: target.primaryFirstName,
        vehicleReg,
        jobName: job.job_name || `#${job.hh_job_number || ''}`.trim(),
        returnedAt,
      },
    });
    if (result.success) {
      console.log(`[vehicle-emails] check-in: email sent to ${target.primaryEmail} for assignment ${assignmentId}${target.isFallback ? ' (fallback to info@)' : ''}`);
      if (target.isFallback) {
        await logFallbackToTimeline({ jobId, templateId: 'vehicle_checked_in' });
      }
    } else {
      console.warn(`[vehicle-emails] check-in: email send failed for assignment ${assignmentId}:`, result);
    }
  } catch (err) {
    console.error(`[vehicle-emails] check-in: unexpected error for assignment ${assignmentId}:`, err);
  }
}

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
