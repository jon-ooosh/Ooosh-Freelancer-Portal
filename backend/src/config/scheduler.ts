import cron from 'node-cron';
import { isR2Configured } from './r2';
import { runBackup } from '../scripts/backup';

/**
 * Starts the backup scheduler.
 * Runs daily at 2:00 AM server time.
 */
export function startScheduler() {
  if (!isR2Configured()) {
    console.log('Scheduler: R2 not configured — automated backups disabled');
    return;
  }

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
