/**
 * Confirmation Hooks
 *
 * Shared logic that runs when a job transitions to 'confirmed' — either via the
 * Payment Portal (money.ts payment-event) or a manual pipeline status change
 * (pipeline.ts).
 *
 * Two jobs:
 *   1. Run HH requirement derivation inline. For a job that was synced in from
 *      HireHop (rather than created in OP), the vehicle / hire_forms requirements
 *      may not have been derived yet when the confirmation fires — the scheduled
 *      30-min sync hasn't run. Doing this inline closes that timing gap.
 *   2. Trigger the hire form email if appropriate, with a structured reason code
 *      so the caller can tell the difference between "intentionally skipped"
 *      (van & driver, not self-drive, too far out) and "silently failed"
 *      (derivation says there's a van but the requirement is missing, or we
 *      can't find any client contacts to email).
 *
 * The caller decides when to alert info@ — see `sendConfirmationSilentSkipAlert`.
 */
import { query } from '../config/database';
import { emailService } from './email-service';

export type HireFormTriggerReason =
  | 'sent'
  | 'van_and_driver'
  | 'no_hh_job'
  | 'no_job_date'
  | 'too_far_out'
  | 'already_actioned'
  | 'no_self_drive'
  | 'requirement_missing'
  | 'no_contacts'
  | 'error';

export interface HireFormTriggerResult {
  sent: number;
  reason: HireFormTriggerReason;
  context?: string;
  hasSelfDrive?: boolean;
}

/**
 * Called when a job transitions to 'confirmed'. Runs HH-derivation inline
 * then fires the hire form email if the preconditions are met.
 * Returns a reason code describing what happened — callers use this to decide
 * whether to raise a silent-skip alert.
 */
export async function triggerHireFormEmailOnConfirmation(
  jobId: string
): Promise<HireFormTriggerResult> {
  const jobData = await query(
    `SELECT job_date, is_van_and_driver, hh_job_number FROM jobs WHERE id = $1`,
    [jobId]
  );
  if (jobData.rows.length === 0) {
    return { sent: 0, reason: 'error', context: 'job row not found' };
  }
  const { job_date, is_van_and_driver, hh_job_number } = jobData.rows[0];

  if (is_van_and_driver) return { sent: 0, reason: 'van_and_driver' };
  if (!hh_job_number) return { sent: 0, reason: 'no_hh_job' };
  if (!job_date) return { sent: 0, reason: 'no_job_date' };

  const daysUntilStart = Math.ceil(
    (new Date(job_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  if (daysUntilStart > 10) {
    return { sent: 0, reason: 'too_far_out', context: `${daysUntilStart} days away` };
  }

  // Run HH-derivation inline — fetches fresh items + creates/updates requirements.
  // For HH-synced jobs where the 30-min scheduler hasn't caught up yet, this is
  // what makes the hire_forms requirement exist before we check for it below.
  let hasSelfDrive = false;
  try {
    const { fetchLineItemsOnDemand } = await import('./hirehop-job-sync');
    const items = await fetchLineItemsOnDemand(hh_job_number);
    if (items.length > 0) {
      await query(
        `UPDATE jobs SET line_items = $1, line_items_synced_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(items), jobId]
      );
    }
    const { deriveRequirementsForJob } = await import('./hh-requirement-derivation');
    const derivation = await deriveRequirementsForJob(jobId);
    hasSelfDrive = derivation.flags.self_drive_count > 0;
    console.log(
      `[confirmation-hooks] Job ${hh_job_number} derivation ran — self-drive count: ${derivation.flags.self_drive_count}`
    );
  } catch (err) {
    console.error(
      `[confirmation-hooks] Derivation failed for job ${jobId}:`,
      err instanceof Error ? err.message : err
    );
    // Fall through — if the requirement already exists from a prior sync we can
    // still fire the email. If not, we'll report a reason that triggers an alert.
  }

  const hfReq = await query(
    `SELECT id, status FROM job_requirements WHERE job_id = $1 AND requirement_type = 'hire_forms'`,
    [jobId]
  );
  if (hfReq.rows.length === 0) {
    return {
      sent: 0,
      reason: hasSelfDrive ? 'requirement_missing' : 'no_self_drive',
      hasSelfDrive,
    };
  }
  if (hfReq.rows[0].status !== 'not_started') {
    return {
      sent: 0,
      reason: 'already_actioned',
      context: `status: ${hfReq.rows[0].status}`,
      hasSelfDrive,
    };
  }

  const jobRow = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
            jr.id AS req_id
     FROM jobs j JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'hire_forms'
     WHERE j.id = $1`,
    [jobId]
  );
  if (jobRow.rows.length === 0) {
    return { sent: 0, reason: 'error', context: 'job row vanished during lookup', hasSelfDrive };
  }

  const { sendHireFormEmailForJob } = await import('./hire-form-auto-email');
  console.log(
    `[confirmation-hooks] Job ${hh_job_number} confirmed with ${daysUntilStart} days to go — triggering hire form email`
  );
  const sent = await sendHireFormEmailForJob(jobRow.rows[0], false);
  if (sent === 0) return { sent: 0, reason: 'no_contacts', hasSelfDrive };
  return { sent, reason: 'sent', hasSelfDrive };
}

export type SilentSkipIssueKind = 'hire_form_email' | 'payment_email';

export interface SilentSkipIssue {
  kind: SilentSkipIssueKind;
  reason: string;
  context?: string;
}

/**
 * Decides whether a hire form trigger result counts as a "silent skip worth
 * alerting on" vs an intentional no-op. Intentional skips (van & driver, too
 * far out, no self-drive, already actioned) do NOT alert. Failures to send
 * when we'd have expected to DO alert.
 */
export function hireFormResultIsAnomaly(
  result: HireFormTriggerResult
): SilentSkipIssue | null {
  switch (result.reason) {
    case 'requirement_missing':
      return {
        kind: 'hire_form_email',
        reason: 'hire_forms requirement missing despite self-drive vehicle detected by HH',
        context: result.context,
      };
    case 'no_contacts':
      return {
        kind: 'hire_form_email',
        reason: 'no client contacts found to email — check OP address book has an email for this org',
        context: result.context,
      };
    case 'error':
      return {
        kind: 'hire_form_email',
        reason: 'unexpected error while triggering hire form email',
        context: result.context,
      };
    default:
      return null;
  }
}

/**
 * Sends an alert email to info@oooshtours.co.uk when a confirmation event
 * should have triggered one or more emails but silently skipped them.
 * Fire-and-forget from the caller's perspective — logs but does not throw.
 */
export async function sendConfirmationSilentSkipAlert(opts: {
  jobId: string;
  jobNumber: number | string | null;
  jobName: string | null;
  clientName: string | null;
  triggerSource: 'payment_event' | 'status_change';
  issues: SilentSkipIssue[];
}): Promise<void> {
  if (opts.issues.length === 0) return;

  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';
    const jobUrl = `${frontendUrl}/jobs/${opts.jobId}`;
    const issuesList = opts.issues
      .map(
        (i) =>
          `<li style="margin:0 0 8px;"><strong>${labelForKind(i.kind)}:</strong> ${escape(
            i.reason
          )}${i.context ? ` <em style="color:#64748b;">(${escape(i.context)})</em>` : ''}</li>`
      )
      .join('');

    const triggerLabel =
      opts.triggerSource === 'payment_event'
        ? 'Payment Portal payment'
        : 'manual pipeline status change';

    const html = `
      <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Booking confirmed but some emails were skipped</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Job <strong>${escape(String(opts.jobNumber ?? '(no HH number)'))}</strong>
        ${opts.jobName ? `(${escape(opts.jobName)})` : ''}
        was confirmed via ${triggerLabel}, but one or more automated emails did not fire:
      </p>
      <ul style="margin:0 0 16px 20px;padding:0;font-size:14px;color:#334155;line-height:1.5;">
        ${issuesList}
      </ul>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Client: <strong>${escape(opts.clientName || '(not set)')}</strong>
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.5;">
        Common cause: the job was imported from HireHop but the client organisation has no
        email on its OP record and no contacts with emails linked to it. Fix the address book,
        then manually re-trigger the relevant email from the Job Detail page.
      </p>
      <p style="margin:0;font-size:14px;">
        <a href="${jobUrl}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `;

    await emailService.sendRaw({
      to: 'info@oooshtours.co.uk',
      subject: `[Booking confirmed] Emails skipped — ${opts.jobNumber ?? opts.jobId}`,
      html,
      variant: 'internal',
    });

    console.log(
      `[confirmation-hooks] Silent-skip alert sent to info@ for job ${opts.jobNumber ?? opts.jobId} (${opts.issues.length} issue${opts.issues.length === 1 ? '' : 's'})`
    );
  } catch (err) {
    console.error('[confirmation-hooks] Failed to send silent-skip alert:', err);
  }
}

function labelForKind(kind: SilentSkipIssueKind): string {
  switch (kind) {
    case 'hire_form_email':
      return 'Hire form email';
    case 'payment_email':
      return 'Payment confirmation email';
    default:
      return kind;
  }
}

function escape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
