import cron from 'node-cron';
import { isR2Configured } from './r2';
import { runBackup } from '../scripts/backup';
import { isHireHopConfigured } from './hirehop';
import { syncJobsFromHireHop } from '../services/hirehop-job-sync';
import { query } from './database';

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
}
