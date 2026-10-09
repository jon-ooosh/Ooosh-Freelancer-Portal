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
import type { PoolClient } from 'pg';
import { uploadToR2, isR2Configured } from '../config/r2';
import { getClient } from '../config/database';

dotenv.config();

interface BackupResult {
  key: string;
  size: number;
  timestamp: string;
}

// Advisory lock key, shared by every entry point into runBackup(). Follows the
// hashtext() convention used by cost-xero-push.ts.
const BACKUP_LOCK_KEY = 'db-backup';

/**
 * Take a backup, unless another one is already running.
 *
 * Guards against the whole class of "two schedulers, one job". On 8 Sep 2026 a
 * root crontab entry (`node dist/scripts/backup.js`) was found running at 02:00
 * alongside the in-app scheduler, producing two identical ~33 MB dumps 1.4s
 * apart every night. The scheduler's R2 recency check couldn't catch it: both
 * processes listed R2 in the same second, before either had uploaded, so both
 * saw "no recent backup" and proceeded. A check-then-act guard can't win a race
 * it's inside of.
 *
 * A Postgres advisory lock is atomic, so it can. It's also session-scoped —
 * if a backup process is killed mid-dump the lock dies with its connection,
 * so there's no stale lock to clear by hand.
 *
 * try_ rather than the blocking variant on purpose: a second backup should be
 * ABANDONED, not queued up to run a moment later — queueing it would still
 * produce two dumps, which is the thing we're preventing.
 *
 * Returns null when another backup holds the lock.
 */
async function runBackup(): Promise<BackupResult | null> {
  let client: PoolClient | null = null;

  try {
    client = await getClient();
    const res = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',
      [BACKUP_LOCK_KEY],
    );
    if (!res.rows[0]?.locked) {
      client.release();
      console.log('Backup skipped — another backup is already in progress');
      return null;
    }
  } catch (err) {
    // Failed to take the lock for a reason OTHER than contention (database
    // unreachable, pool exhausted). Proceed unguarded rather than let the guard
    // itself become the reason a backup is missed — the same trade-off the
    // scheduler's R2 recency check already makes: a duplicate is cheaper than a
    // gap. pg_dump talks to this same database, so it will surface any real
    // outage on its own a moment later.
    if (client) client.release();
    client = null;
    console.warn('Backup: advisory lock unavailable, proceeding unguarded:', err);
  }

  try {
    return await runBackupLocked();
  } finally {
    if (client) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [BACKUP_LOCK_KEY]);
      } catch (err) {
        console.error('Backup: advisory unlock failed:', err);
      }
      client.release();
    }
  }
}

async function runBackupLocked(): Promise<BackupResult> {
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
    // Run pg_dump and gzip — capture stderr for error reporting
    try {
      execSync(`pg_dump "${dbUrl}" 2>/tmp/pgdump_err.log | gzip > "${tmpPath}"`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000, // 5 minute timeout
      });
    } catch (dumpErr) {
      // Read stderr for details
      let errDetail = '';
      try { errDetail = readFileSync('/tmp/pgdump_err.log', 'utf-8'); } catch { /* ignore */ }
      console.error('pg_dump failed:', errDetail || dumpErr);
      throw new Error(`pg_dump failed: ${errDetail || dumpErr}`);
    }

    const fileBuffer = readFileSync(tmpPath);
    const sizeMB = (fileBuffer.length / (1024 * 1024)).toFixed(2);
    console.log(`Backup created: ${sizeMB} MB`);

    // Check for suspiciously small backups (empty gzip is ~20 bytes)
    if (fileBuffer.length < 100) {
      let errDetail = '';
      try { errDetail = readFileSync('/tmp/pgdump_err.log', 'utf-8'); } catch { /* ignore */ }
      console.error(`Backup appears empty (${fileBuffer.length} bytes). pg_dump may have failed silently.`, errDetail);
      throw new Error(`Backup empty (${fileBuffer.length} bytes). pg_dump error: ${errDetail || 'unknown'}`);
    }

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
