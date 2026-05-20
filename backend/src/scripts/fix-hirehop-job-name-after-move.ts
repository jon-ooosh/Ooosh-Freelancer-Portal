/**
 * Follow-up to move-driver-forms-15293-to-15911.ts: that script repointed
 * job_id / hirehop_job_id but left `vehicle_hire_assignments.hirehop_job_name`
 * stale (still "Josh Law - Vito"). Staff saw the old job name in the BookOut
 * hire-form picker, and the auto-pick logic likely cross-references it.
 *
 * This script refreshes hirehop_job_name on those 3 rows to match HH #15911's
 * current job_name, so Rayner + Sozos don't hit the same confusion at
 * book-out time.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/fix-hirehop-job-name-after-move.ts            # dry-run
 *   npx tsx src/scripts/fix-hirehop-job-name-after-move.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');

const TARGET_HH = 15911;
const DRIVER_LAST_NAMES = ['Rayner', 'Caley', 'Sozos'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}\n`);

    const job = await client.query(
      `SELECT id, hh_job_number, job_name FROM jobs WHERE hh_job_number = $1`,
      [TARGET_HH]
    );
    if (job.rowCount === 0) {
      console.error(`✗ Target job HH ${TARGET_HH} not found`);
      process.exit(1);
    }
    const correctName = job.rows[0].job_name;
    console.log(`Target: #${TARGET_HH}  ${job.rows[0].id}  "${correctName}"\n`);

    const nameClauses = DRIVER_LAST_NAMES.map((_, i) => `d.full_name ILIKE $${i + 2}`).join(' OR ');
    const rows = await client.query(
      `SELECT vha.id, vha.hirehop_job_name AS current_name, d.full_name
         FROM vehicle_hire_assignments vha
         JOIN drivers d ON d.id = vha.driver_id
        WHERE vha.hirehop_job_id = $1
          AND (${nameClauses})
        ORDER BY d.full_name`,
      [TARGET_HH, ...DRIVER_LAST_NAMES.map((n) => `%${n}%`)]
    );

    console.log(`── Rows to refresh (${rows.rowCount}) ──`);
    for (const r of rows.rows) {
      const drift = r.current_name !== correctName ? ' ← STALE' : ' (already correct)';
      console.log(`  ${r.id}  ${r.full_name.padEnd(35)} hirehop_job_name="${r.current_name}"${drift}`);
    }

    if (!commit) {
      console.log(`\n(dry-run — re-run with --commit to apply)`);
      return;
    }

    const ids = rows.rows.map((r: any) => r.id);
    const upd = await client.query(
      `UPDATE vehicle_hire_assignments
          SET hirehop_job_name = $1,
              updated_at = NOW()
        WHERE id = ANY($2::uuid[])
          AND (hirehop_job_name IS DISTINCT FROM $1)
        RETURNING id`,
      [correctName, ids]
    );
    console.log(`\n✓ Updated ${upd.rowCount} row(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
