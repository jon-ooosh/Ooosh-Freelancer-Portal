/**
 * One-shot cleanup script: backfill HH ↔ OP pipeline_status mismatches for
 * legacy pre-OP jobs.
 *
 * Diagnosed via audit-status-mismatch.ts. As of 11 May 2026 the audit
 * reported 725 mismatches across 1960 jobs; 709 of those fit one of two
 * simple "forward-only state advance" rules:
 *
 *   1. pipeline_status='confirmed' AND hh_status=11 (Completed)
 *      → set pipeline_status='completed' (701 jobs)
 *   2. pipeline_status='lost' AND hh_status=9 (Cancelled)
 *      → set pipeline_status='cancelled' (8 jobs)
 *
 * Everything else needs human judgement (recent provisional/prepping/etc.)
 * and is left alone.
 *
 * Cutoff is `return_date < 2026-05-01` by default — anything inside the last
 * couple of weeks is staff-eyeball territory.
 *
 * As part of the same sweep, any STILL-OPEN post_hire (close-out) job
 * requirements on the cleaned jobs are cancelled. These were almost
 * certainly auto-created by the HH-derivation engine when HH status reached
 * 6+, and on jobs that completed years before OP existed they're pure noise
 * on the Returns / dashboard widgets. Pre_hire requirements are left
 * untouched (they're harmless for completed jobs and not what was asked
 * for).
 *
 * Dry-run by default. Pass `--commit` to actually write.
 * Override cutoff with `--before YYYY-MM-DD`.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx ts-node src/scripts/backfill-status-mismatch.ts        # dry-run
 *   npx ts-node src/scripts/backfill-status-mismatch.ts --commit
 *   npx ts-node src/scripts/backfill-status-mismatch.ts --commit --before 2026-04-15
 *
 * Side-effects this script deliberately does NOT do:
 *   - No HireHop writeback (HH already has the correct status).
 *   - No notifications fired (these are historical, no-one's waiting).
 *   - No interactions logged per row (would clutter ~700 timelines no-one
 *     reads).
 *   - No completion retros (also historical).
 *   - No completed close-out requirements created (pre-OP — never going to
 *     be actioned).
 *
 * If you need a manual audit trail of what changed, capture the dry-run
 * output to a file before committing.
 */

import { query, getClient } from '../config/database';

const DEFAULT_CUTOFF = '2026-05-01';

interface MismatchRow {
  id: string;
  hh_job_number: number | null;
  pipeline_status: 'confirmed' | 'lost';
  hh_status: number;
  job_name: string | null;
  client_name: string | null;
  return_date: Date | string | null;
  target_status: 'completed' | 'cancelled';
}

async function main() {
  const commit = process.argv.includes('--commit');
  const beforeIdx = process.argv.indexOf('--before');
  const cutoff = beforeIdx > -1 ? process.argv[beforeIdx + 1] : DEFAULT_CUTOFF;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
    console.error(`Invalid --before value: ${cutoff} (expected YYYY-MM-DD)`);
    process.exit(2);
  }

  console.log(`Mode: ${commit ? 'COMMIT (writes will be applied)' : 'DRY-RUN (no writes)'}`);
  console.log(`Cutoff: return_date < ${cutoff}`);
  console.log('');

  // Find rows matching either rule
  const candidates = await query(
    `SELECT id,
            hh_job_number,
            pipeline_status,
            status AS hh_status,
            job_name,
            client_name,
            return_date,
            CASE
              WHEN pipeline_status = 'confirmed' AND status = 11 THEN 'completed'
              WHEN pipeline_status = 'lost'      AND status = 9  THEN 'cancelled'
            END::text AS target_status
     FROM jobs
     WHERE is_deleted = false
       AND return_date IS NOT NULL
       AND return_date::date < $1::date
       AND (
         (pipeline_status = 'confirmed' AND status = 11)
         OR (pipeline_status = 'lost' AND status = 9)
       )
     ORDER BY return_date ASC`,
    [cutoff]
  );

  const rows = candidates.rows as MismatchRow[];
  const byTarget = {
    completed: rows.filter((r) => r.target_status === 'completed'),
    cancelled: rows.filter((r) => r.target_status === 'cancelled'),
  };

  console.log('=== Candidates ===');
  console.log(`Total: ${rows.length}`);
  console.log(`  confirmed → completed  (HH=11): ${byTarget.completed.length}`);
  console.log(`  lost      → cancelled  (HH=9):  ${byTarget.cancelled.length}`);
  console.log('');

  if (rows.length === 0) {
    console.log('Nothing to do. Exiting.');
    process.exit(0);
  }

  // Spot check — preview the first 5 and last 5
  console.log('=== Preview (first 5, last 5) ===');
  const preview = [...rows.slice(0, 5), ...(rows.length > 10 ? rows.slice(-5) : [])];
  for (const r of preview) {
    const ret = formatDate(r.return_date);
    console.log(
      `  #${String(r.hh_job_number ?? '?').padEnd(8)} ` +
      `${r.pipeline_status} → ${r.target_status}  ` +
      `(${ret})  ${(r.client_name || '?').slice(0, 30)} — ${(r.job_name || '?').slice(0, 40)}`
    );
  }
  console.log('');

  if (!commit) {
    console.log('Dry-run complete. Re-run with --commit to apply.');
    console.log('');
    console.log(`Would update ${rows.length} jobs and cancel open post_hire requirements on the same set.`);
    process.exit(0);
  }

  // Live mode — wrap in a transaction
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1. Move confirmed → completed
    const completedResult = await client.query(
      `UPDATE jobs
       SET pipeline_status = 'completed',
           pipeline_status_changed_at = NOW(),
           next_chase_date = NULL,
           updated_at = NOW()
       WHERE is_deleted = false
         AND return_date IS NOT NULL
         AND return_date::date < $1::date
         AND pipeline_status = 'confirmed'
         AND status = 11
       RETURNING id`,
      [cutoff]
    );
    console.log(`✓ Updated ${completedResult.rowCount} confirmed → completed`);

    // 2. Move lost → cancelled
    const cancelledResult = await client.query(
      `UPDATE jobs
       SET pipeline_status = 'cancelled',
           pipeline_status_changed_at = NOW(),
           next_chase_date = NULL,
           updated_at = NOW()
       WHERE is_deleted = false
         AND return_date IS NOT NULL
         AND return_date::date < $1::date
         AND pipeline_status = 'lost'
         AND status = 9
       RETURNING id`,
      [cutoff]
    );
    console.log(`✓ Updated ${cancelledResult.rowCount} lost → cancelled`);

    const touchedJobIds = [
      ...completedResult.rows.map((r) => r.id as string),
      ...cancelledResult.rows.map((r) => r.id as string),
    ];

    if (touchedJobIds.length === 0) {
      console.log('No jobs changed — nothing else to do.');
      await client.query('COMMIT');
      process.exit(0);
    }

    // 3. Cancel open post_hire requirements on the touched jobs.
    // "Open" = anything not already 'done' or 'cancelled'. Pre_hire rows
    // are left as-is.
    const reqResult = await client.query(
      `UPDATE job_requirements
       SET status = 'cancelled',
           notes = COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END
                   || '[Auto-cancelled: pre-OP legacy cleanup ' || to_char(NOW(), 'YYYY-MM-DD') || ']',
           updated_at = NOW()
       WHERE job_id = ANY($1::uuid[])
         AND phase = 'post_hire'
         AND status NOT IN ('done', 'cancelled')
       RETURNING id`,
      [touchedJobIds]
    );
    console.log(`✓ Cancelled ${reqResult.rowCount} open post_hire job_requirements rows`);

    await client.query('COMMIT');
    console.log('');
    console.log('All changes committed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
  }

  process.exit(0);
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
