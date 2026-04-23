import cron from 'node-cron';
import { isR2Configured } from './r2';
import { runBackup } from '../scripts/backup';
import { isHireHopConfigured } from './hirehop';
import { syncJobsFromHireHop } from '../services/hirehop-job-sync';
import { runComplianceCheck } from '../services/compliance-checker';
import { query } from './database';
import { generateBVRLACSV } from '../routes/ve103b';
import emailService from '../services/email-service';
import { getFrontendUrl } from './app-urls';

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
         RETURNING id, job_name, hh_job_number, next_chase_date,
                   client_name, chase_alert_user_id, chase_alert_delivery`
      );

      if (result.rows.length > 0) {
        console.log(`Scheduler: Chase auto-mover moved ${result.rows.length} job(s) to chasing`);

        // Get admin/manager users for notifications
        const admins = await query(
          `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`
        );
        const adminIds = admins.rows.map((r: Record<string, unknown>) => r.id as string);

        // Log a status_transition interaction + create inbox notification for each moved job
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

            // Chase alert recipient + delivery preference: prefer what's
            // persisted on the job itself (set via the ChaseModal). Fall back
            // to the most-recent interaction's chase_alert_user_id if nothing
            // is stored on the job (legacy data), then to admins as last resort.
            let targetUsers: string[] = [];
            let isAdminFallback = false;
            if (job.chase_alert_user_id) {
              targetUsers = [job.chase_alert_user_id as string];
            } else {
              const lastChase = await query(
                `SELECT chase_alert_user_id FROM interactions
                 WHERE job_id = $1 AND type = 'chase' AND chase_alert_user_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1`,
                [job.id]
              );
              if (lastChase.rows.length > 0 && lastChase.rows[0].chase_alert_user_id) {
                targetUsers = [lastChase.rows[0].chase_alert_user_id as string];
              } else {
                // Unassigned chase: spray admin/manager bells AND send an email
                // copy to info@ so the shared inbox has a paper trail.
                targetUsers = adminIds;
                isAdminFallback = true;
              }
            }

            // Delivery preference → notification priority. 'bell_email' becomes
            // 'urgent' so the escalation scheduler emails it immediately.
            // 'bell' (or unspecified) is 'normal' — bell shows, email follows
            // after 4h if still unread per the user's notification prefs.
            const priority = job.chase_alert_delivery === 'bell_email' ? 'urgent' : 'normal';

            const jobName = job.job_name || `Job ${job.hh_job_number || ''}`;
            for (const userId of targetUsers) {
              try {
                await query(
                  `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
                   VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4, $5, $6)`,
                  [
                    userId,
                    `Chase due: ${jobName}`,
                    `Chase date reached for ${jobName} — needs follow-up`,
                    job.id,
                    `/jobs/${job.id}?tab=timeline`,
                    priority,
                  ]
                );
              } catch { /* dedup or other error — non-critical */ }
            }

            // If nobody was explicitly assigned, also email info@ so the
            // shared inbox sees it alongside the admin/manager bells.
            if (isAdminFallback) {
              try {
                const lastChased = await query(
                  `SELECT MAX(created_at) AS last_chased_at
                   FROM interactions
                   WHERE job_id = $1 AND type = 'chase'`,
                  [job.id]
                );
                const lastChaseDate = lastChased.rows[0]?.last_chased_at
                  ? new Date(lastChased.rows[0].last_chased_at as string).toISOString().split('T')[0]
                  : '—';
                await emailService.send('chase_reminder', {
                  to: 'info@oooshtours.co.uk',
                  variables: {
                    jobName,
                    jobNumber: job.hh_job_number ? String(job.hh_job_number) : '—',
                    clientName: job.client_name || '—',
                    lastChaseDate,
                    jobUrl: `${getFrontendUrl()}/jobs/${job.id}?tab=timeline`,
                  },
                });
              } catch (err) {
                console.error('Scheduler: info@ chase email failed:', err);
              }
            }
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

  // ── Close-Out Requirement Chase Scanner ─────────────────────────────
  // Daily at 09:30 — check for overdue post-hire requirements and create notifications
  cron.schedule('30 9 * * *', async () => {
    console.log('Scheduler: Scanning for overdue close-out requirements...');
    try {
      // Find post_hire requirements with overdue due_date that haven't been notified today
      const overdue = await query(`
        SELECT jr.id, jr.job_id, jr.requirement_type, jr.custom_label, jr.due_date,
               jr.assigned_to, jr.notes, jr.delivery_method,
               j.hh_job_number, j.job_name, j.client_name,
               rtd.label AS type_label
        FROM job_requirements jr
        JOIN jobs j ON j.id = jr.job_id AND j.is_deleted = false
        JOIN requirement_type_definitions rtd ON rtd.type = jr.requirement_type
        WHERE jr.phase = 'post_hire'
          AND jr.status NOT IN ('done', 'blocked', 'cancelled')
          AND jr.due_date IS NOT NULL
          AND jr.due_date::date <= CURRENT_DATE
          AND j.status IN (6, 7, 8)
      `);

      if (overdue.rows.length === 0) {
        console.log('Scheduler: No overdue close-out requirements found');
        return;
      }

      // Get admin/manager users to notify (if no assigned_to on the requirement)
      const admins = await query(
        `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`
      );
      const adminIds = admins.rows.map((r: Record<string, unknown>) => r.id as string);

      let created = 0;
      for (const req of overdue.rows) {
        const jobName = req.job_name || req.client_name || `Job ${req.hh_job_number || ''}`;
        const label = req.custom_label || req.type_label;
        const daysOverdue = Math.floor((Date.now() - new Date(req.due_date as string).getTime()) / 86400000);
        const title = `Overdue: ${label} — ${jobName}`;
        const content = `${label} was due ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} ago${req.notes ? `: ${req.notes}` : ''}`;

        // Notify assigned user, or all admins/managers
        const targetUsers = req.assigned_to ? [req.assigned_to] : adminIds;

        for (const userId of targetUsers) {
          // Dedup: don't create if already notified in last 24h for this requirement
          const existing = await query(
            `SELECT id FROM notifications
             WHERE user_id = $1 AND entity_type = 'job_requirements' AND entity_id = $2
               AND created_at > NOW() - INTERVAL '24 hours'`,
            [userId, req.id]
          );
          if (existing.rows.length > 0) continue;

          // Respect per-requirement delivery_method
          const deliveryMethod = req.delivery_method || 'both';
          const basePriority = daysOverdue > 7 ? 'high' : 'normal';
          // notification-only → low priority (escalation scheduler skips email for low)
          const effectivePriority = deliveryMethod === 'notification' ? 'low' : basePriority;

          await query(
            `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
             VALUES ($1, 'chase_alert', $2, $3, 'job_requirements', $4, $5, $6)`,
            [
              userId, title, content, req.id,
              `/jobs/${req.job_id}?tab=overview`,
              effectivePriority,
            ]
          );

          // If email-only, send immediately and mark as emailed
          if (deliveryMethod === 'email') {
            try {
              const userResult = await query('SELECT u.email, p.first_name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1', [userId]);
              if (userResult.rows.length > 0 && userResult.rows[0].email) {
                await emailService.sendRaw({
                  to: userResult.rows[0].email,
                  subject: title,
                  html: `<p>Hi ${userResult.rows[0].first_name || ''},</p>
                         <p><strong>${label}</strong> for job <strong>${jobName}</strong> was due ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} ago.</p>
                         ${req.notes ? `<p>Notes: ${req.notes}</p>` : ''}
                         <p><a href="${getFrontendUrl()}/jobs/${req.job_id}?tab=overview">View Job</a></p>`,
                });
              }
            } catch (emailErr) {
              console.warn('Scheduler: Chase scanner email failed:', emailErr);
            }
          }

          created++;
        }
      }

      if (created > 0) {
        console.log(`Scheduler: Created ${created} overdue close-out notifications for ${overdue.rows.length} requirements`);
      }
    } catch (err) {
      console.error('Scheduler: Close-out chase scan failed:', err);
    }
  });
  console.log('Scheduler: Close-out requirement chase scanner scheduled daily at 09:30');

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

  // ── Reminder Scanner (due-date reminders) ────────────────────────────
  // Hourly — fires `reminder` requirements with a due_date <= today that
  // haven't been dispatched yet. Works regardless of phase or job status,
  // which distinguishes it from the close-out scanner.
  cron.schedule('0 * * * *', async () => {
    try {
      const due = await query(`
        SELECT jr.id, jr.job_id, jr.custom_label, jr.notes, jr.due_date,
               jr.assigned_to, jr.created_by, jr.delivery_method,
               j.hh_job_number, j.job_name, j.client_name, j.pipeline_status
        FROM job_requirements jr
        JOIN jobs j ON j.id = jr.job_id AND j.is_deleted = false
        WHERE jr.requirement_type = 'reminder'
          AND jr.status NOT IN ('done', 'blocked', 'cancelled')
          AND jr.due_date IS NOT NULL
          AND jr.due_date::date <= CURRENT_DATE
      `);

      if (due.rows.length === 0) return;

      let created = 0;
      for (const rem of due.rows) {
        const jobName = rem.job_name || rem.client_name || `Job ${rem.hh_job_number || ''}`;
        const label = rem.custom_label || 'Reminder';
        const title = `Reminder: ${label}`;
        const content = `${label}${rem.notes && rem.notes !== rem.custom_label ? ` — ${rem.notes}` : ''} (${jobName})`;
        const deliveryMethod = rem.delivery_method || 'both';

        // Target: assigned user if set, else the user who created the reminder.
        // Reminders default to the creator — they're personal, not team-wide.
        const targetUserId = rem.assigned_to || rem.created_by;
        if (!targetUserId) continue;

        // Dedup: don't re-create if we already notified this user for this
        // reminder in the last 24h (cron catches up quickly after a restart).
        const existing = await query(
          `SELECT id FROM notifications
           WHERE user_id = $1 AND entity_type = 'job_requirements' AND entity_id = $2
             AND created_at > NOW() - INTERVAL '24 hours'`,
          [targetUserId, rem.id]
        );
        if (existing.rows.length > 0) continue;

        // Priority controls email escalation cadence.
        // notification-only → low (escalation scheduler skips email for low).
        // email / both → normal (so the escalator will email within a few hours).
        const priority = deliveryMethod === 'notification' ? 'low' : 'normal';

        const inserted = await query(
          `INSERT INTO notifications
            (user_id, type, title, content, entity_type, entity_id, action_url, priority)
           VALUES ($1, 'follow_up', $2, $3, 'job_requirements', $4, $5, $6)
           RETURNING id`,
          [
            targetUserId, title, content, rem.id,
            `/jobs/${rem.job_id}?tab=overview`,
            priority,
          ]
        );

        // Send email immediately for email-only delivery (time-sensitive)
        if (deliveryMethod === 'email') {
          try {
            const userResult = await query(
              `SELECT u.email, p.first_name
               FROM users u LEFT JOIN people p ON p.id = u.person_id
               WHERE u.id = $1`,
              [targetUserId]
            );
            if (userResult.rows.length > 0 && userResult.rows[0].email) {
              await emailService.sendRaw({
                to: userResult.rows[0].email,
                subject: title,
                html: `<p>Hi ${userResult.rows[0].first_name || ''},</p>
                       <p>Reminder: <strong>${label}</strong> for <strong>${jobName}</strong>.</p>
                       ${rem.notes && rem.notes !== rem.custom_label ? `<p>Notes: ${rem.notes}</p>` : ''}
                       <p><a href="${getFrontendUrl()}/jobs/${rem.job_id}?tab=overview">View Job</a></p>`,
              });
              await query(
                `UPDATE notifications SET email_sent_at = NOW() WHERE id = $1`,
                [inserted.rows[0].id]
              );
            }
          } catch (emailErr) {
            console.warn('Scheduler: Reminder email failed:', emailErr);
          }
        }

        created++;
      }

      if (created > 0) {
        console.log(`Scheduler: Reminder scanner — ${created} notification(s) created from ${due.rows.length} due reminder(s)`);
      }
    } catch (err) {
      console.error('Scheduler: Reminder scanner failed:', err);
    }
  });
  console.log('Scheduler: Reminder scanner scheduled hourly');

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

  // ── Freelancer completion chaser ─────────────────────────────────────
  // Every 30 minutes — nudge freelancers who haven't completed jobs that
  // are past their scheduled time. Levels: 2h / 6h / 14h, then staff
  // escalation. Business hours only (London 07:00–22:00).
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { runCompletionChase } = await import('../services/completion-chaser');
      const result = await runCompletionChase();
      if (result.scanned > 0 || result.sent > 0) {
        console.log(
          `Scheduler: Completion chase — scanned ${result.scanned}, sent ${result.sent}, skipped ${result.skipped}`
        );
      }
    } catch (err) {
      console.error('Scheduler: Completion chaser failed:', err);
    }
  });
  console.log('Scheduler: Completion chaser scheduled every 30 minutes');

  // ── Transport/crew arranging chaser ──────────────────────────────────
  // Daily at 08:30 — nudge STAFF (info@oooshtours.co.uk) about transport
  // quotes still sat in ops_status='todo' as the job date approaches.
  // Levels: T-5 days / T-3 days / T-1 day. Business-hours-gated inside
  // the service. Runs once a day because bumping multiple levels in one
  // morning is fine, but sending the same level twice isn't.
  cron.schedule('30 8 * * *', async () => {
    try {
      const { runArrangingChase } = await import('../services/arranging-chaser');
      const result = await runArrangingChase();
      if (result.scanned > 0 || result.sent > 0) {
        console.log(
          `Scheduler: Arranging chase — scanned ${result.scanned}, sent ${result.sent}, skipped ${result.skipped}`
        );
      }
    } catch (err) {
      console.error('Scheduler: Arranging chaser failed:', err);
    }
  });
  console.log('Scheduler: Arranging chaser scheduled daily at 08:30');
}
