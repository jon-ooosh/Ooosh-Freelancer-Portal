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
import { sendOohReminderEmails } from '../services/ooh-return';

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

  // ── Chase Alert Scanner ───────────────────────────────────────────────
  // Daily at 08:00, fire bell/email alerts for jobs that have crossed their
  // next_chase_date AND have an explicit chase_alert_user_id.
  //
  // No status writes — 'chasing' is a derived view (next_chase_date + status
  // pre-confirmed), the Kanban surfaces these jobs in the Chasing column on
  // its own. Default behaviour for chase dates is silent: cards just appear
  // in the Chasing pile. Bell/email alerts only fire when staff explicitly
  // opted in via the ChaseModal (chase_alert_user_id set, delivery !=
  // 'none'). Dedup by "no chase_alert notification created in the last 24h".
  cron.schedule('0 8 * * *', async () => {
    try {
      const result = await query(
        `SELECT j.id, j.job_name, j.hh_job_number, j.client_name,
                j.chase_alert_user_id, j.chase_alert_delivery
         FROM jobs j
         WHERE j.is_deleted = false
           AND j.next_chase_date IS NOT NULL
           AND j.next_chase_date <= CURRENT_DATE
           AND j.pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')
           AND j.chase_alert_user_id IS NOT NULL
           AND COALESCE(j.chase_alert_delivery, 'bell') != 'none'
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.entity_type = 'jobs'
               AND n.entity_id = j.id
               AND n.type = 'chase_alert'
               AND n.created_at >= NOW() - INTERVAL '24 hours'
           )`
      );

      if (result.rows.length === 0) return;
      console.log(`Scheduler: Chase alert scanner — ${result.rows.length} alert(s) to fire`);

      for (const job of result.rows) {
        try {
          // 'bell_email' → 'urgent' for immediate email escalation; 'bell' →
          // 'normal' (bell now, email after 4h if still unread per user prefs).
          const priority = job.chase_alert_delivery === 'bell_email' ? 'urgent' : 'normal';
          const jobName = job.job_name || `Job ${job.hh_job_number || ''}`;
          // Inline actions: log a chase, snooze 2 days. Reduces "open card →
          // navigate → click chase → log it → come back" to one click.
          const actions = JSON.stringify([
            { kind: 'mark_chased', label: 'Mark chased', success_message: 'Chase logged + bumped.' },
          ]);
          await query(
            `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, actions)
             VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4, $5, $6, $7::jsonb)`,
            [
              job.chase_alert_user_id,
              `Chase due: ${jobName}`,
              `Chase date reached for ${jobName} — needs follow-up`,
              job.id,
              `/jobs/${job.id}?tab=timeline`,
              priority,
              actions,
            ]
          );
        } catch {
          // Non-critical — don't block other alerts
        }
      }
    } catch (err) {
      console.error('Scheduler: Chase alert scanner failed:', err);
    }
  });
  console.log('Scheduler: Chase alert scanner scheduled daily at 08:00');

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
  // Daily at 09:00 — mark unconfirmed enquiries as lost if job_date was yesterday or earlier.
  // Runs 1 day after start date to avoid losing last-minute confirmations. Scheduled
  // for 09:00 (office start) so staff don't begin the day with phantom enquiries
  // still cluttering operational lists like backline prep.
  cron.schedule('0 9 * * *', async () => {
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
           AND pipeline_status IN ('new_enquiry', 'quoting', 'paused', 'provisional')
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
  console.log('Scheduler: Stale enquiry auto-lose scheduled daily at 09:00');

  // ── OOH Return Reminder ─────────────────────────────────────────────
  // Daily at 10:00 — send the day-before reminder for any vehicle with
  // return_overnight=true and hire_end=tomorrow.
  cron.schedule('0 10 * * *', async () => {
    try {
      const summary = await sendOohReminderEmails();
      if (summary.sent > 0) {
        console.log(`Scheduler: OOH reminders sent: ${summary.sent} (skipped ${summary.skipped})`);
      }
    } catch (err) {
      console.error('Scheduler: OOH reminder run failed:', err);
    }
  });
  console.log('Scheduler: OOH return reminders scheduled daily at 10:00');

  // ── Close-Out Requirement Chase Scanner ─────────────────────────────
  // Daily at 09:30 — check for overdue post-hire requirements and create notifications
  cron.schedule('30 9 * * *', async () => {
    console.log('Scheduler: Scanning for overdue close-out requirements...');
    try {
      // Find post_hire requirements with overdue due_date that haven't been notified today.
      // Skip lost/cancelled pipeline jobs unless the requirement was kept alive
      // (keep_after_close=true) via the cleanup section in the Lost/Cancelled
      // modal. See CLAUDE.md → "Lost / Cancelled cleanup pattern".
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
          AND (
            j.pipeline_status NOT IN ('lost', 'cancelled')
            OR jr.keep_after_close = true
          )
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

          // Close-out requirements are always post_hire — phase included in
          // URL so the inbox link lands on the right toggle.
          await query(
            `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
             VALUES ($1, 'chase_alert', $2, $3, 'job_requirements', $4, $5, $6)`,
            [
              userId, title, content, req.id,
              `/jobs/${req.job_id}?tab=overview&phase=post_hire`,
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
                         <p><a href="${getFrontendUrl()}/jobs/${req.job_id}?tab=overview&phase=post_hire">View Job</a></p>`,
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
      // Skip lost/cancelled jobs unless the requirement was explicitly kept
      // alive past close-out (keep_after_close=true) via the cleanup section
      // in the Lost/Cancelled modal. See CLAUDE.md → "Lost / Cancelled
      // cleanup pattern".
      const due = await query(`
        SELECT jr.id, jr.job_id, jr.custom_label, jr.notes, jr.due_date, jr.phase,
               jr.assigned_to, jr.created_by, jr.delivery_method, jr.updated_at,
               j.hh_job_number, j.job_name, j.client_name, j.pipeline_status
        FROM job_requirements jr
        JOIN jobs j ON j.id = jr.job_id AND j.is_deleted = false
        WHERE jr.requirement_type = 'reminder'
          AND jr.status NOT IN ('done', 'blocked', 'cancelled')
          AND jr.due_date IS NOT NULL
          AND jr.due_date::date <= CURRENT_DATE
          AND (
            j.pipeline_status NOT IN ('lost', 'cancelled')
            OR jr.keep_after_close = true
          )
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

        // Dedup: skip if (a) we already notified this user within 24h, OR
        // (b) any prior notification for this requirement is already
        // acknowledged AND the requirement hasn't been edited since the
        // acknowledgement (= user has handled it; respect that even if the
        // requirement still has an open status). The acknowledge endpoint
        // also cascades reminder requirements to status='done' so that
        // primary case is already filtered out by the SQL above — this is
        // a defence-in-depth for edge cases (e.g. status reset, snooze
        // chains, manual DB edits).
        const existing = await query(
          `SELECT id FROM notifications
           WHERE user_id = $1 AND entity_type = 'job_requirements' AND entity_id = $2
             AND (
               created_at > NOW() - INTERVAL '24 hours'
               OR (acknowledged_at IS NOT NULL AND acknowledged_at >= $3)
             )`,
          [targetUserId, rem.id, rem.updated_at || new Date(0)]
        );
        if (existing.rows.length > 0) continue;

        // Priority controls email escalation cadence.
        // notification-only → low (escalation scheduler skips email for low).
        // email / both → normal (so the escalator will email within a few hours).
        const priority = deliveryMethod === 'notification' ? 'low' : 'normal';

        // Include phase in URL so the inbox link lands on the right toggle
        // (otherwise pre-hire reminders are invisible when the page defaults
        // to post-hire on dispatched+ jobs, and vice versa).
        const phaseQs = rem.phase ? `&phase=${rem.phase}` : '';
        // Inline action: complete the requirement directly from the inbox.
        // The acknowledge cascade already handled reminder-type requirements
        // via the Done button; this exposes the same outcome explicitly as
        // a labelled action button for any close-out / pre-hire requirement.
        const actions = JSON.stringify([
          { kind: 'complete_requirement', label: 'Mark done', success_message: 'Requirement marked done.' },
        ]);
        const inserted = await query(
          `INSERT INTO notifications
            (user_id, type, title, content, entity_type, entity_id, action_url, priority, actions)
           VALUES ($1, 'follow_up', $2, $3, 'job_requirements', $4, $5, $6, $7::jsonb)
           RETURNING id`,
          [
            targetUserId, title, content, rem.id,
            `/jobs/${rem.job_id}?tab=overview${phaseQs}`,
            priority,
            actions,
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
                       <p><a href="${getFrontendUrl()}/jobs/${rem.job_id}?tab=overview${phaseQs}">View Job</a></p>`,
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

  // ── Pre-Hire Briefing ────────────────────────────────────────────────
  // Daily at 09:55 — every confirmed job approaching its hire date gets a
  // structured briefing email sent to info@oooshtours.co.uk. Replaces the
  // Monday.com automation. Triggers (any one):
  //   - 3 days to out_date (standard)
  //   - 5 days to out_date AND has D&C quote or crew (transport-heavy / earlier)
  //   - 1 day to out_date AND any hire form missing (urgent)
  // Each job sent at most once per day per trigger reason; email_log
  // dedupes naturally if the cron is restarted within the same day.
  // Explicit Europe/London timezone — server runs in UTC, so without
  // this the cron would fire at 09:55 UTC = 10:55 BST in summer / 09:55
  // GMT in winter. Pinning the zone makes "9:55am UK time" mean exactly
  // that, year-round, regardless of DST.
  cron.schedule('55 9 * * *', async () => {
    try {
      const { findEligibleJobs, sendBriefingEmail } = await import('../services/pre-hire-briefing');

      const eligible = await findEligibleJobs();
      if (eligible.length === 0) {
        console.log('Scheduler: Pre-hire review — no eligible jobs today');
        return;
      }

      // Skip jobs that already received a briefing today by HH job number
      // (the email_log subject contains "#NNNN ..."). The dedup is across
      // ANY trigger reason — if we sent today, we don't send again today.
      //
      // The column on email_log is `created_at`, NOT `sent_at` — there's
      // no separate sent_at column. Wrapped in its own try/catch so a
      // future schema drift here doesn't tank the whole cron run silently
      // (which is exactly what bit us on the first scheduled run).
      const today = new Date().toISOString().slice(0, 10);
      const sentJobNumbers = new Set<number>();
      try {
        const sentResult = await query(
          `SELECT subject FROM email_log
            WHERE template_id = 'pre_hire_briefing'
              AND status = 'sent'
              AND created_at::date = $1::date`,
          [today],
        );
        for (const row of (sentResult.rows as Array<{ subject: string }>)) {
          const m = /#(\d+)/.exec(row.subject || '');
          if (m) sentJobNumbers.add(parseInt(m[1], 10));
        }
      } catch (err) {
        // Don't let dedup failure block sends. Worst case we send twice
        // on a same-day cron restart — much better than silent zero-send.
        console.error('Scheduler: Pre-hire review dedup query failed, proceeding without dedup:', err);
      }

      let sent = 0; let skipped = 0; let failed = 0;
      for (const e of eligible) {
        if (e.hh_job_number && sentJobNumbers.has(e.hh_job_number)) { skipped++; continue; }
        try {
          // Triggered-by null = scheduler attribution (system user).
          const result = await sendBriefingEmail(e.id, undefined, null);
          if (result.success) sent++;
          else { failed++; console.warn(`Scheduler: Pre-hire review send failed for ${e.id}:`, result.error); }
        } catch (err) {
          console.error(`Scheduler: Pre-hire review failed for job ${e.id}:`, err);
          failed++;
        }
      }
      console.log(
        `Scheduler: Pre-hire review — eligible ${eligible.length}, sent ${sent}, skipped (already sent today) ${skipped}, failed ${failed}`
      );
    } catch (err) {
      console.error('Scheduler: Pre-hire review run failed:', err);
    }
  }, { timezone: 'Europe/London' });
  console.log('Scheduler: Pre-hire review scheduled daily at 09:55 Europe/London');
}
