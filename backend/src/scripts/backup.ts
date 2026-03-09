/**
 * Database Backup Script
 *
 * Runs pg_dump and uploads the compressed backup to Cloudflare R2.
 * Can be run manually: npx tsx src/scripts/backup.ts
 * Or scheduled via cron on the server.
 */
import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { uploadToR2, isR2Configured } from '../config/r2';

dotenv.config();

async function runBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `ooosh-backup-${timestamp}.sql.gz`;
  const tmpPath = path.join(tmpdir(), filename);

  console.log(`Starting database backup: ${filename}`);

  if (!isR2Configured()) {
    console.error('R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env');
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  try {
    // Run pg_dump and gzip
    execSync(`pg_dump "${dbUrl}" | gzip > "${tmpPath}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000, // 5 minute timeout
    });

    const fileBuffer = readFileSync(tmpPath);
    const sizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`Backup created: ${sizeMB} MB`);

    // Upload to R2
    const key = `backups/${filename}`;
    await uploadToR2(key, fileBuffer, 'application/gzip');
    console.log(`Uploaded to R2: ${key}`);

    // Clean up temp file
    unlinkSync(tmpPath);
    console.log('Backup complete');

    return { key, size: fileBuffer.length, timestamp };
  } catch (error) {
    // Clean up temp file on error
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    console.error('Backup failed:', error);
    throw error;
  }
}

// Run directly if called as a script
if (require.main === module) {
  runBackup()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { runBackup };
