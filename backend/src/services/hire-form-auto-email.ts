/**
 * Hire Form Auto-Email Service
 *
 * Runs daily (09:00) to send hire form emails for self-drive jobs:
 * - 8-11 days before job_date: initial hire form request email (self-healing
 *   window — pre-May 2026 this was an exact `= 10` match, which silently lost
 *   any job that wasn't in the right state on the single day the cron looked.
 *   Now any of 4 days will catch it; the `notes NOT LIKE 'Hire form email
 *   sent%'` guard prevents duplicates).
 * - If confirmed with <11 days to go: send on confirmation (handled by
 *   pipeline status change + payment-event + HH webhook).
 * - 4-5 days before job_date: chase email if initial was sent and no forms
 *   received (unless initial was sent <24h ago, in which case wait).
 * - Missed-initial backstop: if a job hits the 4-5 day window but no initial
 *   was ever sent (e.g. confirmed late, scheduler missed every window day,
 *   contact lookup returned 0 then), send the INITIAL email — not a chase.
 *   Without this backstop, jobs that slipped through the initial window had
 *   no recovery path at all.
 */

import { query } from '../config/database';
import emailService from './email-service';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from './money-emails';
import { sendConfirmationSilentSkipAlert } from './confirmation-hooks';

export interface AutoEmailResult {
  initialSent: number;
  chaseSent: number;
  skipped: number;
  errors: string[];
}

export async function sendAutoHireFormEmails(): Promise<AutoEmailResult> {
  const result: AutoEmailResult = { initialSent: 0, chaseSent: 0, skipped: 0, errors: [] };

  try {
    const now = new Date();

    // ── Initial emails: jobs with self-drive vehicles, job_date 8-11 days out
    // ── Self-healing window — any of 4 days will catch the job. The notes
    //    guard ('Hire form email sent') prevents duplicates within the window.
    const initialJobs = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
              jr.id AS req_id, jr.notes AS req_notes
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'hire_forms'
       WHERE j.is_deleted = false
         AND j.is_van_and_driver = false
         AND j.hh_job_number IS NOT NULL
         AND j.job_date IS NOT NULL
         AND jr.status = 'not_started'
         AND j.pipeline_status = 'confirmed'
         AND j.job_date::date - CURRENT_DATE BETWEEN 8 AND 11
         AND (jr.notes IS NULL OR jr.notes NOT LIKE '%Hire form email sent%')
       ORDER BY j.job_date ASC`
    );

    for (const job of initialJobs.rows) {
      try {
        const sent = await sendHireFormEmailForJob(job, false);
        if (sent > 0) result.initialSent += sent;
        else result.skipped++;
      } catch (err) {
        result.errors.push(`Initial email for job ${job.hh_job_number}: ${err}`);
      }
    }

    // ── Chase + missed-initial backstop: jobs 4-5 days out, no forms received.
    //    Two cases:
    //    a) Initial was sent → send chase (unless <24h since initial). The
    //       initial send flips requirement status to 'in_progress', so the
    //       chase MUST match both 'not_started' and 'in_progress'. Pre-May
    //       2026 this clause was `status = 'not_started'` and the chase loop
    //       was effectively dead code in normal operation — only the
    //       backstop case ever reached it. Forms submitted flips status to
    //       'done', which is correctly excluded here.
    //    b) Initial was NEVER sent (slipped through the 8-11 day window) →
    //       send initial as a backstop. Surfaces any prior auto-emailer gap.
    const lateWindowJobs = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
              jr.id AS req_id, jr.notes AS req_notes
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'hire_forms'
       WHERE j.is_deleted = false
         AND j.is_van_and_driver = false
         AND j.hh_job_number IS NOT NULL
         AND j.job_date IS NOT NULL
         AND jr.status IN ('not_started', 'in_progress')
         AND j.pipeline_status = 'confirmed'
         AND j.job_date::date - CURRENT_DATE BETWEEN 4 AND 5
       ORDER BY j.job_date ASC`
    );

    for (const job of lateWindowJobs.rows) {
      try {
        const notes = job.req_notes || '';
        const initialSent = notes.includes('Hire form email sent');
        const reminderSent = notes.includes('Hire form reminder sent');

        if (!initialSent) {
          // Missed-initial backstop. Treat as initial, with an alert noting it
          // arrived late.
          console.warn(
            `[Hire Form Auto-Email] Missed-initial backstop firing for job ${job.hh_job_number} (4-5 days out, never received initial)`
          );
          const sent = await sendHireFormEmailForJob(job, false, { isLateBackstop: true });
          if (sent > 0) result.initialSent += sent;
          else result.skipped++;
          continue;
        }

        if (reminderSent) {
          // Already chased — don't double-chase
          result.skipped++;
          continue;
        }

        // Was the initial sent <24h ago? If so, hold the chase another day.
        const lastSentMatch = notes.match(/Hire form email sent.*on (\d{2}\/\d{2}\/\d{4})/);
        if (lastSentMatch) {
          const parts = lastSentMatch[1].split('/');
          const lastSentDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          const hoursSinceSent = (now.getTime() - lastSentDate.getTime()) / (1000 * 60 * 60);
          if (hoursSinceSent < 24) {
            result.skipped++;
            continue;
          }
        }

        const sent = await sendHireFormEmailForJob(job, true);
        if (sent > 0) result.chaseSent += sent;
        else result.skipped++;
      } catch (err) {
        result.errors.push(`Chase email for job ${job.hh_job_number}: ${err}`);
      }
    }

  } catch (err) {
    console.error('[Hire Form Auto-Email] Error:', err);
    result.errors.push(String(err));
  }

  return result;
}

/**
 * Send the hire form email for a specific job to the routed client contact.
 * Returns the number of emails sent (0 or 1).
 *
 * Recipient resolution goes through `resolveClientEmailTarget(job, templateId)`
 * — the SAME routing-aware path that payment / excess / delivery emails use:
 *   1. per-job email-routing override for the `hire_forms` bucket
 *      ("Hire forms & driver" on the Job Detail routing panel), then
 *   2. the per-job contact selection (job_contacts) — primary becomes the
 *      `to`, the other ticked contacts become CC, then
 *   3. org-level fallbacks, then
 *   4. info@ with the amber "no client email on file" banner.
 *
 * This deliberately does NOT use the broad `resolveHireFormContacts` resolver
 * (client org email + every org person + job_organisations links + HH
 * contact-name match). That resolver is the additive *candidate picker* for
 * the manual "Send hire form" UI, where staff tick who to include. Using it
 * for the AUTO send blasted a separate email to every reachable address
 * (band gmail, org emails, management contacts…) instead of the people
 * actually selected on the hire — fixed Jun 2026.
 *
 * `isLateBackstop` flags the missed-initial backstop case so we can surface
 * via the silent-skip alert that the auto-emailer slipped a window.
 */
export async function sendHireFormEmailForJob(
  job: { id: string; hh_job_number: number; job_name: string; job_date: string; company_name: string; client_name: string; client_id: string | null; req_id: string },
  isChase: boolean,
  opts: { isLateBackstop?: boolean } = {}
): Promise<number> {
  const templateId = isChase ? 'hire_form_chase' : 'hire_form_request';

  // Routing-aware resolution — honours the "Hire forms & driver" override,
  // then the ticked job_contacts (primary = to, rest = CC), then org
  // fallbacks, then info@. Always returns a deliverable primaryEmail.
  const target = await resolveClientEmailTarget(job.id, templateId);
  const sentToFallback = target.isFallback;
  const ccEmails = target.ccEmails || [];

  const hireFormUrl = `https://hireforms.oooshtours.co.uk/?job=${job.hh_job_number}`;
  const jobDate = job.job_date ? new Date(job.job_date) : null;
  const startDay = jobDate ? jobDate.toLocaleDateString('en-GB', { weekday: 'long' }) : '';
  const startDate = jobDate ? jobDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  let sent = 0;
  const sentEmails: string[] = [];
  try {
    await emailService.send(templateId, {
      to: target.primaryEmail,
      cc: ccEmails.length > 0 ? ccEmails : undefined,
      variables: {
        clientName: target.primaryFirstName || 'there',
        jobNumber: String(job.hh_job_number),
        jobName: job.job_name || '',
        startDay,
        startDate,
        hireFormUrl,
      },
      prependBanner: sentToFallback
        ? buildFallbackBanner({
            jobId: job.id,
            clientName: job.client_name || job.company_name || null,
            jobNumber: String(job.hh_job_number),
            jobName: job.job_name || null,
          })
        : undefined,
    });
    sent = 1;
    sentEmails.push(target.primaryEmail, ...ccEmails);
  } catch (err) {
    console.warn(`[Hire Form Auto-Email] Failed to send to ${target.primaryEmail}:`, err);
  }

  if (sentToFallback && sent > 0) {
    await logFallbackToTimeline({ jobId: job.id, templateId });
  }

  // If the late backstop fired (initial sent because we slipped the 8-11 day
  // window), alert info@ so we can investigate WHY it slipped. Don't gate on
  // `sent > 0` — even a successful late send is worth flagging.
  if (opts.isLateBackstop && sent > 0) {
    sendConfirmationSilentSkipAlert({
      jobId: job.id,
      jobNumber: job.hh_job_number,
      jobName: job.job_name ?? null,
      clientName: job.client_name ?? null,
      triggerSource: 'status_change',
      issues: [{
        kind: 'hire_form_email',
        reason: 'hire form initial email fired from the 4-5 day backstop — the 8-11 day window was missed',
        context: `Sent late to ${sentEmails.join(', ')}. Check why the earlier window did not fire (job confirmation timing, contact lookup, or scheduler error).`,
      }],
    }).catch(e => console.error('[Hire Form Auto-Email] Late-backstop alert failed:', e));
  }

  // Update the requirement notes
  if (sent > 0) {
    const notePrefix = isChase ? 'Hire form reminder sent' : 'Hire form email sent';
    await query(
      `UPDATE job_requirements SET
         notes = COALESCE(notes, '') || E'\n' || $1,
         updated_at = NOW()
       WHERE id = $2`,
      [
        `${notePrefix} to ${sentEmails.join(', ')} on ${new Date().toLocaleDateString('en-GB')}`,
        job.req_id,
      ]
    );

    // If this is the initial send, move status to indicate forms have been sent
    if (!isChase) {
      await query(
        `UPDATE job_requirements SET status = 'in_progress', current_step = 'Sent'
         WHERE id = $1 AND status = 'not_started'`,
        [job.req_id]
      );
    }
  }

  console.log(`[Hire Form Auto-Email] ${isChase ? 'Chase' : 'Initial'} for job ${job.hh_job_number}: ${sent > 0 ? `sent to ${sentEmails.join(', ')}${sentToFallback ? ' (info@ fallback)' : ''}` : 'send failed'}`);
  return sent;
}
