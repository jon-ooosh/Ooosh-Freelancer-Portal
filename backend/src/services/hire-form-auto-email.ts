/**
 * Hire Form Auto-Email Service
 *
 * Runs daily (09:00) to send hire form emails for self-drive jobs:
 * - 10 days before job_date: initial hire form request email
 * - If confirmed with <10 days to go: send on confirmation (handled by pipeline status change)
 * - 5 days before job_date: chase email if no hire forms received
 *   (unless initial was sent <24h ago, in which case chase at 4 days)
 */

import { query } from '../config/database';
import emailService from './email-service';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from './money-emails';

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

    // ── Initial emails: jobs with self-drive vehicles, job_date in 10 days ──
    // Find jobs that:
    // 1. Have a vehicle requirement (is_auto, source=hirehop_sync)
    // 2. Are NOT van_and_driver
    // 3. Have a hire_forms requirement that's still not_started
    // 4. job_date is 10 days from now (or fewer if just confirmed)
    // 5. Haven't had a hire form email sent yet (notes don't contain 'Hire form email sent')
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
         AND j.pipeline_status IN ('confirmed', 'provisional')
         AND j.job_date::date - CURRENT_DATE = 10
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

    // ── Chase emails: jobs with job_date in 5 days, no hire forms received ──
    // Check that initial wasn't sent in the last 24 hours (if so, wait until 4 days)
    const chaseJobs = await query(
      `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
              jr.id AS req_id, jr.notes AS req_notes
       FROM jobs j
       JOIN job_requirements jr ON jr.job_id = j.id AND jr.requirement_type = 'hire_forms'
       WHERE j.is_deleted = false
         AND j.is_van_and_driver = false
         AND j.hh_job_number IS NOT NULL
         AND j.job_date IS NOT NULL
         AND jr.status = 'not_started'
         AND j.pipeline_status IN ('confirmed', 'provisional')
         AND j.job_date::date - CURRENT_DATE BETWEEN 4 AND 5
         AND (jr.notes IS NULL OR jr.notes NOT LIKE '%Hire form reminder sent%')
         AND (jr.notes LIKE '%Hire form email sent%')
       ORDER BY j.job_date ASC`
    );

    for (const job of chaseJobs.rows) {
      try {
        // Check if initial was sent <24h ago (from notes timestamp)
        const notes = job.req_notes || '';
        const lastSentMatch = notes.match(/Hire form email sent.*on (\d{2}\/\d{2}\/\d{4})/);
        if (lastSentMatch) {
          const parts = lastSentMatch[1].split('/');
          const lastSentDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          const hoursSinceSent = (now.getTime() - lastSentDate.getTime()) / (1000 * 60 * 60);
          if (hoursSinceSent < 24) {
            // Sent less than 24h ago — skip this cycle, will pick up at 4 days
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
 * Send hire form email(s) for a specific job to client contacts.
 * Returns the number of emails sent.
 */
export async function sendHireFormEmailForJob(
  job: { id: string; hh_job_number: number; job_name: string; job_date: string; company_name: string; client_name: string; client_id: string | null; req_id: string },
  isChase: boolean
): Promise<number> {
  // Gather contacts — client org email + people linked to client org
  const contacts: Array<{ email: string; name: string }> = [];

  if (job.client_id) {
    // Org email
    const orgResult = await query(
      `SELECT email, name FROM organisations WHERE id = $1 AND email IS NOT NULL AND email != ''`,
      [job.client_id]
    );
    if (orgResult.rows.length > 0 && orgResult.rows[0].email) {
      contacts.push({ email: orgResult.rows[0].email, name: orgResult.rows[0].name });
    }

    // People at the org
    const peopleResult = await query(
      `SELECT p.email, p.first_name, p.last_name
       FROM person_organisation_roles por
       JOIN people p ON p.id = por.person_id
       WHERE por.organisation_id = $1 AND p.email IS NOT NULL AND p.email != '' AND p.is_deleted = false
       LIMIT 5`,
      [job.client_id]
    );
    for (const p of peopleResult.rows) {
      if (!contacts.some(c => c.email === p.email)) {
        contacts.push({ email: p.email, name: `${p.first_name} ${p.last_name}`.trim() });
      }
    }
  }

  const hireFormUrl = `https://hireforms.oooshtours.co.uk/?job=${job.hh_job_number}`;
  const jobDate = job.job_date ? new Date(job.job_date) : null;
  const startDay = jobDate ? jobDate.toLocaleDateString('en-GB', { weekday: 'long' }) : '';
  const startDate = jobDate ? jobDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const templateId = isChase ? 'hire_form_chase' : 'hire_form_request';

  // Safety net: if we couldn't find any client contacts, route the email to
  // info@ once (with the amber "no client email on file" banner + timeline
  // entry) so staff can forward and update the address book. Otherwise the
  // hire form would never go out at all and no one would know.
  let sentToFallback = false;
  if (contacts.length === 0) {
    const target = await resolveClientEmailTarget(job.id);
    if (target.isFallback) {
      contacts.push({ email: target.primaryEmail, name: target.primaryFirstName });
      sentToFallback = true;
    }
  }

  let sent = 0;
  for (const contact of contacts) {
    try {
      await emailService.send(templateId, {
        to: contact.email,
        variables: {
          clientName: contact.name || 'there',
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
      sent++;
    } catch (err) {
      console.warn(`[Hire Form Auto-Email] Failed to send to ${contact.email}:`, err);
    }
  }

  if (sentToFallback && sent > 0) {
    await logFallbackToTimeline({ jobId: job.id, templateId });
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
        `${notePrefix} to ${contacts.filter((_, i) => i < sent).map(c => c.email).join(', ')} on ${new Date().toLocaleDateString('en-GB')}`,
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

  console.log(`[Hire Form Auto-Email] ${isChase ? 'Chase' : 'Initial'} for job ${job.hh_job_number}: sent to ${sent}/${contacts.length} contacts`);
  return sent;
}
