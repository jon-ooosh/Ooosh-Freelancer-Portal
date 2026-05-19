/**
 * Backup Retention Sweep
 *
 * Deletes old database backups from R2 according to the retention policy:
 *   - Keep every backup younger than 30 days
 *   - Keep the OLDEST backup from each calendar month forever (monthly snapshot)
 *   - Delete everything else
 *
 * Idempotent — safe to run repeatedly. Dry-run by default; pass `commit: true`
 * to actually delete.
 *
 * Can be run manually: npx tsx src/scripts/backup-retention.ts [--commit]
 * Or scheduled via the scheduler at 02:30 daily.
 */
import dotenv from 'dotenv';
import { listR2Objects, deleteFromR2, isR2Configured } from '../config/r2';

dotenv.config();

const DAILY_RETENTION_DAYS = 30;

interface BackupEntry {
  key: string;
  lastModified: Date;
  size: number;
}

interface RetentionResult {
  scanned: number;
  kept: number;
  deleted: number;
  keptKeys: string[];
  deletedKeys: string[];
  errors: Array<{ key: string; error: string }>;
}

/**
 * Decide which backups to keep vs delete.
 *
 * Rules (in order):
 *   1. If lastModified is within the last DAILY_RETENTION_DAYS days → keep.
 *   2. Else, if this is the OLDEST backup in its calendar month (YYYY-MM)
 *      across the full set → keep as a monthly snapshot.
 *   3. Otherwise → delete.
 *
 * Returns { keep, delete } sets of keys.
 */
function planRetention(backups: BackupEntry[], now = new Date()): { keep: Set<string>; toDelete: Set<string> } {
  const keep = new Set<string>();
  const toDelete = new Set<string>();

  const cutoff = new Date(now.getTime() - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Bucket by YYYY-MM and find the oldest in each bucket.
  const oldestPerMonth = new Map<string, BackupEntry>();
  for (const b of backups) {
    const ym = `${b.lastModified.getUTCFullYear()}-${String(b.lastModified.getUTCMonth() + 1).padStart(2, '0')}`;
    const current = oldestPerMonth.get(ym);
    if (!current || b.lastModified < current.lastModified) {
      oldestPerMonth.set(ym, b);
    }
  }
  const monthlyKeepKeys = new Set(Array.from(oldestPerMonth.values()).map((b) => b.key));

  for (const b of backups) {
    if (b.lastModified >= cutoff) {
      keep.add(b.key);
    } else if (monthlyKeepKeys.has(b.key)) {
      keep.add(b.key);
    } else {
      toDelete.add(b.key);
    }
  }

  return { keep, toDelete };
}

async function runRetentionSweep(commit: boolean): Promise<RetentionResult> {
  if (!isR2Configured()) {
    throw new Error('R2 not configured');
  }

  const objects = await listR2Objects('backups/');
  const backups: BackupEntry[] = objects
    .filter((o) => o.Key && o.Key.endsWith('.sql.gz') && o.LastModified)
    .map((o) => ({
      key: o.Key!,
      lastModified: o.LastModified!,
      size: o.Size || 0,
    }));

  const { keep, toDelete } = planRetention(backups);

  const result: RetentionResult = {
    scanned: backups.length,
    kept: keep.size,
    deleted: 0,
    keptKeys: Array.from(keep).sort(),
    deletedKeys: [],
    errors: [],
  };

  for (const key of toDelete) {
    if (!commit) {
      result.deletedKeys.push(key);
      result.deleted++;
      continue;
    }
    try {
      await deleteFromR2(key);
      result.deletedKeys.push(key);
      result.deleted++;
    } catch (err) {
      result.errors.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

// Run directly if called as a script
if (require.main === module) {
  const commit = process.argv.includes('--commit');
  console.log(`Backup retention sweep — ${commit ? 'COMMIT' : 'DRY RUN'}`);
  runRetentionSweep(commit)
    .then((r) => {
      console.log(`Scanned: ${r.scanned}, kept: ${r.kept}, ${commit ? 'deleted' : 'would delete'}: ${r.deleted}`);
      if (r.deletedKeys.length > 0) {
        console.log(`${commit ? 'Deleted' : 'Would delete'}:`);
        r.deletedKeys.forEach((k) => console.log(`  ${k}`));
      }
      if (r.errors.length > 0) {
        console.error(`Errors: ${r.errors.length}`);
        r.errors.forEach((e) => console.error(`  ${e.key}: ${e.error}`));
      }
      process.exit(r.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Retention sweep failed:', err);
      process.exit(1);
    });
}

export { runRetentionSweep, planRetention };
