import cron from 'node-cron';
import { isR2Configured } from './r2';
import { runBackup } from '../scripts/backup';
import { isHireHopConfigured } from './hirehop';
import { syncJobsFromHireHop } from '../services/hirehop-job-sync';
import { runComplianceCheck } from '../services/compliance-checker';
import { query } from './database';
import { generateBVRLACSV } from '../routes/ve103b';
import emailService from '../services/email-service';

/**
 * Starts the backup and sync schedulers.
 */
export function startScheduler() {
  // ── Backups ────────────────────────────────────────────────────────────
  if (!isR2Configured()) {
    console.log('Scheduler: R2 not configured — automated backups disabled');
  } else {
    // Daily at 2:00 AM
    cron.schedule('0 2 * * *', async () => {
      console.log('Scheduler: Starting daily backup...');
      try {
        const result = await runBackup();
        console.log(`Scheduler: Backup complete — ${result.key}`);
      } catch (err) {
        console.error('Scheduler: Backup failed:', err);
      }
    });
    console.log('Scheduler: Daily backup scheduled at 02:00');
  }

  // ── HireHop Job Sync ──────────────────────────────────────────────────
  if (!isHireHopConfigured()) {
    console.log('Scheduler: HireHop not configured — job sync disabled');
  } else {
    // Every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      console.log('Scheduler: Starting HireHop job sync...');
      try {
        // Log sync start
        const logResult = await query(
          `INSERT INTO sync_log (sync_type, triggered_by) VALUES ('jobs', 'scheduled') RETURNING id`
        );
        const logId = logResult.rows[0].id;

        const result = await syncJobsFromHireHop('system');

        // Log sync completion
        await query(
          `UPDATE sync_log SET status = 'completed', completed_at = NOW(), result = $1 WHERE id = $2`,
          [JSON.stringify(result), logId]
        );

        console.log(`Scheduler: Job sync complete — ${result.jobsCreated} created, ${result.jobsUpdated} updated`);

        // Run HH-derived requirement derivation after line items sync
        try {
          const { deriveRequirementsForActiveJobs } = await import('../services/hh-requirement-derivation');
          const deriveResult = await deriveRequirementsForActiveJobs();
          console.log(`Scheduler: Requirement derivation — ${deriveResult.processed} jobs, ${deriveResult.created} requirements created, ${deriveResult.mismatches} mismatches`);
        } catch (deriveErr) {
          console.error('Scheduler: Requirement derivation failed:', deriveErr);
        }
      } catch (err) {
        console.error('Scheduler: Job sync failed:', err);
        // Try to log failure
        try {
          await query(
            `UPDATE sync_log SET status = 'failed', completed_at = NOW(), result = $1
             WHERE sync_type = 'jobs' AND status = 'running'
             ORDER BY started_at DESC LIMIT 1`,
            [JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' })]
          );
        } catch { /* ignore logging errors */ }
      }
    });
    console.log('Scheduler: HireHop job sync scheduled every 30 minutes');
  }

  // ── Chase Auto-Mover ──────────────────────────────────────────────────
  // Every 15 minutes, move jobs with overdue chase dates to 'chasing' status
  cron.schedule('*/15 * * * *', async () => {
    try {
      // Find jobs where next_chase_date has arrived and status is an active pipeline stage
      // (not already chasing, confirmed, or lost)
      const result = await query(
        `UPDATE jobs
         SET pipeline_status = 'chasing',
             pipeline_status_changed_at = NOW()
         WHERE next_chase_date <= CURRENT_DATE
           AND next_chase_date IS NOT NULL
           AND pipeline_status IN ('new_enquiry', 'quoting', 'provisional', 'paused')
         RETURNING id, job_name, hh_job_number, next_chase_date`
      );

      if (result.rows.length > 0) {
        console.log(`Scheduler: Chase auto-mover moved ${result.rows.length} job(s) to chasing`);

        // Log a status_transition interaction for each moved job
        for (const job of result.rows) {
          try {
            await query(
              `INSERT INTO interactions (type, content, job_id)
               VALUES ('status_transition', $1, $2)`,
              [
                `Auto-moved to Chasing — chase date ${job.next_chase_date} reached`,
                job.id,
              ]
            );
          } catch {
            // Non-critical — don't block other jobs
          }
        }
      }
    } catch (err) {
      console.error('Scheduler: Chase auto-mover failed:', err);
    }
  });
  console.log('Scheduler: Chase auto-mover scheduled every 15 minutes');

  // ── Vehicle Compliance Check ────────────────────────────────────────
  // Daily at 08:00 — check MOT, Tax, Insurance, TFL due dates
  cron.schedule('0 8 * * *', async () => {
    console.log('Scheduler: Starting vehicle compliance check...');
    try {
      const result = await runComplianceCheck(true);
      console.log(`Scheduler: Compliance check complete — ${result.alerts.length} alerts, ${result.notificationsCreated} notifications created`);
    } catch (err) {
      console.error('Scheduler: Vehicle compliance check failed:', err);
    }
  });
  console.log('Scheduler: Vehicle compliance check scheduled daily at 08:00');

  // ── BVRLA Monthly VE103B Report ────────────────────────────────────
  // 1st of every month at 08:00 — email previous month's VE103B certificates
  cron.schedule('0 8 1 * *', async () => {
    console.log('Scheduler: Generating BVRLA monthly VE103B report...');
    try {
      const now = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0).getDate();
      const startDate = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-${lastDay}`;

      const result = await query(
        `SELECT * FROM ve103b_certificates
         WHERE date_certificate_supplied >= $1 AND date_certificate_supplied <= $2
         ORDER BY date_certificate_supplied ASC, created_at ASC`,
        [startDate, endDate],
      );

      const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const monthName = months[prevMonth.getMonth()];
      const year = prevMonth.getFullYear();

      const issuedCount = result.rows.filter((r: Record<string, unknown>) => r.status === 'issued').length;
      const voidCount = result.rows.filter((r: Record<string, unknown>) => r.status === 'void').length;
      const totalCount = result.rows.length;

      const csv = generateBVRLACSV(result.rows);

      await emailService.sendRaw({
        to: 'will@oooshtours.co.uk',
        cc: ['jon@oooshtours.co.uk'],
        subject: `BVRLA Monthly VE103B Report — ${monthName} ${year}`,
        html: `<p>BVRLA Monthly VE103B Report for <strong>${monthName} ${year}</strong></p>
               <p>${totalCount} certificate${totalCount !== 1 ? 's' : ''} total: ${issuedCount} issued, ${voidCount} voided.</p>
               <p>CSV report attached.</p>`,
        attachments: [{
          filename: `BVRLA-VE103B-${monthName}-${year}.csv`,
          content: Buffer.from(csv, 'utf-8'),
          contentType: 'text/csv',
        }],
      });

      console.log(`Scheduler: BVRLA report sent — ${totalCount} certs (${issuedCount} issued, ${voidCount} voided)`);
    } catch (err) {
      console.error('Scheduler: BVRLA monthly report failed:', err);
    }
  });
  console.log('Scheduler: BVRLA monthly VE103B report scheduled for 1st of each month at 08:00');

  // ── Stale Enquiry Auto-Lose ──────────────────────────────────────────
  // Daily at 10:00 — mark unconfirmed enquiries as lost if job_date was yesterday or earlier.
  // Runs 1 day after start date to avoid losing last-minute confirmations.
  cron.schedule('0 10 * * *', async () => {
    console.log('Scheduler: Checking for stale enquiries to auto-lose...');
    try {
      // Find jobs where:
      // - job_date was yesterday or earlier (start date has passed by at least 1 day)
      // - pipeline_status is still in pre-confirmed stages
      // - HH status < 2 (not yet booked)
      const staleResult = await query(
        `UPDATE jobs
         SET pipeline_status = 'lost',
             pipeline_status_changed_at = NOW(),
             lost_reason = 'No Decision',
             updated_at = NOW()
         WHERE job_date IS NOT NULL
           AND job_date::date < CURRENT_DATE
           AND pipeline_status IN ('new_enquiry', 'quoting', 'chasing', 'paused', 'provisional')
           AND status < 2
           AND is_deleted = false
         RETURNING id, job_name, hh_job_number, pipeline_status, job_date`
      );

      if (staleResult.rows.length > 0) {
        console.log(`Scheduler: Auto-lost ${staleResult.rows.length} stale enquiry/enquiries`);

        // Write back to HireHop + log interaction for each
        const { writeBackStatusToHireHop } = await import('../services/hirehop-writeback');
        for (const job of staleResult.rows) {
          try {
            // Log activity timeline entry
            await query(
              `INSERT INTO interactions (type, content, job_id)
               VALUES ('status_transition', $1, $2)`,
              [
                `Auto-marked as Lost — start date ${new Date(job.job_date as string).toLocaleDateString('en-GB')} has passed without confirmation`,
                job.id,
              ]
            );
            // Push to HireHop (status 10 = Not Interested)
            await writeBackStatusToHireHop(job.id as string, 'lost', 'scheduler:auto_expire');
          } catch (wbErr) {
            console.error(`Scheduler: Auto-lose write-back failed for job ${job.hh_job_number}:`, wbErr);
          }
        }
      }
    } catch (err) {
      console.error('Scheduler: Stale enquiry auto-lose failed:', err);
    }
  });
  console.log('Scheduler: Stale enquiry auto-lose scheduled daily at 10:00');

  // ── Notification Escalation ──────────────────────────────────────────
  // Every 15 minutes — check unread notifications and escalate to email
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { runNotificationEscalation } = await import('../services/notification-escalation');
      const result = await runNotificationEscalation();
      if (result.emailed > 0) {
        console.log(`Scheduler: Notification escalation — ${result.checked} checked, ${result.emailed} emailed, ${result.skipped} skipped`);
      }
    } catch (err) {
      console.error('Scheduler: Notification escalation failed:', err);
    }
  });
  console.log('Scheduler: Notification escalation scheduled every 15 minutes');

  // ── Hire Form Auto-Emails ────────────────────────────────────────────
  // Daily at 09:00 — send hire form emails for self-drive jobs approaching their start date
  // Logic: 10 days before job_date → initial email. 5 days before → chase (if no forms received).
  cron.schedule('0 9 * * *', async () => {
    console.log('Scheduler: Checking hire form email triggers...');
    try {
      const { sendAutoHireFormEmails } = await import('../services/hire-form-auto-email');
      const result = await sendAutoHireFormEmails();
      console.log(`Scheduler: Hire form emails — ${result.initialSent} initial, ${result.chaseSent} chase, ${result.skipped} skipped`);
    } catch (err) {
      console.error('Scheduler: Hire form auto-email failed:', err);
    }
  });
  console.log('Scheduler: Hire form auto-emails scheduled daily at 09:00');
}
