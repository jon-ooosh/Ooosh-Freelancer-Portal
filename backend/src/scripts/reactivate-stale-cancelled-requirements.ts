/**
 * Backfill: reactivate auto-cancelled requirements on resurrected jobs.
 *
 * Closes the historical drift left by the Lost / Cancelled cleanup pattern
 * not having a symmetrical reverse pass. Finds jobs that were moved out of
 * `lost` or `cancelled` before the reactivation hook landed and still carry
 * `job_requirements.status='cancelled'` rows tagged with an auto-marker.
 *
 * Marker-gated — staff-cancelled rows (no marker) are NOT touched.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/reactivate-stale-cancelled-requirements.ts            # dry-run
 *   npx tsx src/scripts/reactivate-stale-cancelled-requirements.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}\n`);

    // Find every cancelled auto-marker row on a job that's no longer lost/cancelled.
    const candidates = await client.query(
      `SELECT jr.id              AS req_id,
              jr.job_id          AS job_id,
              jr.requirement_type,
              jr.notes,
              j.hh_job_number,
              j.job_name,
              j.pipeline_status
         FROM job_requirements jr
         JOIN jobs j ON j.id = jr.job_id
        WHERE jr.status = 'cancelled'
          AND (jr.notes LIKE '%[Auto-cancelled: job marked lost]%'
               OR jr.notes LIKE '%[Cancelled]%')
          AND j.pipeline_status NOT IN ('lost', 'cancelled')
          AND j.is_deleted = false
        ORDER BY j.hh_job_number NULLS LAST, jr.requirement_type`,
    );

    if (candidates.rows.length === 0) {
      console.log('No stale auto-cancelled requirements found. Nothing to do.');
      return;
    }

    console.log(`Found ${candidates.rows.length} stale auto-cancelled requirement(s):\n`);
    const byJob = new Map<string, { hh: string | number | null; jobName: string | null; pipeline: string; types: string[] }>();
    for (const row of candidates.rows) {
      const key = row.job_id as string;
      if (!byJob.has(key)) {
        byJob.set(key, {
          hh: row.hh_job_number,
          jobName: row.job_name,
          pipeline: row.pipeline_status,
          types: [],
        });
      }
      byJob.get(key)!.types.push(row.requirement_type);
    }
    for (const [jobId, info] of byJob) {
      console.log(
        `  ${info.hh ?? '(no HH#)'}  ${info.jobName ?? '(no name)'}  [pipeline: ${info.pipeline}]  types: ${info.types.join(', ')}  (${jobId})`,
      );
    }
    console.log('');

    if (!commit) {
      console.log('Dry run — re-run with --commit to apply.');
      return;
    }

    // Same predicate + strip as runtime helper. Inlined to avoid pulling in
    // the runtime DB pool — this script owns its own connection lifecycle.
    const result = await client.query(
      `UPDATE job_requirements
         SET status = 'not_started',
             notes = NULLIF(
               TRIM(
                 REPLACE(
                   REPLACE(notes, E'\n[Auto-cancelled: job marked lost]', ''),
                   ' [Cancelled]', ''
                 )
               ),
               ''
             ),
             updated_at = NOW()
       WHERE id IN (
         SELECT jr.id
           FROM job_requirements jr
           JOIN jobs j ON j.id = jr.job_id
          WHERE jr.status = 'cancelled'
            AND (jr.notes LIKE '%[Auto-cancelled: job marked lost]%'
                 OR jr.notes LIKE '%[Cancelled]%')
            AND j.pipeline_status NOT IN ('lost', 'cancelled')
            AND j.is_deleted = false
       )
       RETURNING id`,
    );

    console.log(`\nReactivated ${result.rows.length} requirement(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
