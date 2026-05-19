/**
 * Clean up orphaned `vehicle_hire_assignments` rows.
 *
 * Targets two classes of bad data:
 *   1. Non-terminal rows (`soft`, `confirmed`, `booked_out`, `active`) on
 *      jobs whose `pipeline_status` is `lost` or `cancelled`. These get
 *      left behind when a job is moved to lost/cancelled before the
 *      May 2026 sweep was wired in. They keep blocking `syncFleetHireStatus`
 *      from transitioning the linked vehicle out of 'On Hire'.
 *   2. `booked_out` / `active` rows with `booked_out_at IS NULL` — these
 *      shouldn't exist (book-out promotion is supposed to set the timestamp).
 *      Reported, not auto-fixed — surfaces any path still leaking rows into
 *      `booked_out` without a real book-out event.
 *
 * For class 1 the script soft-cancels (status='cancelled' + audit note) and
 * runs `syncFleetHireStatus` for each affected vehicle so the cached
 * fleet status updates immediately.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/cleanup-orphan-assignments.ts            # dry-run
 *   npx tsx src/scripts/cleanup-orphan-assignments.ts --commit   # apply
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

    // ── Class 1: orphan non-terminal rows on lost/cancelled jobs ──────
    const orphans = await client.query(
      `SELECT vha.id,
              vha.status,
              vha.vehicle_id,
              vha.hirehop_job_id,
              vha.job_id,
              vha.booked_out_at,
              fv.reg,
              j.hh_job_number,
              j.pipeline_status AS job_pipeline,
              j.job_name
         FROM vehicle_hire_assignments vha
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         LEFT JOIN jobs j
           ON (vha.job_id IS NOT NULL AND j.id = vha.job_id)
              OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
        WHERE vha.status IN ('soft', 'confirmed', 'booked_out', 'active')
          AND j.pipeline_status IN ('lost', 'cancelled')
        ORDER BY j.pipeline_status, j.hh_job_number, vha.status`
    );

    console.log(`── Class 1: orphan rows on lost/cancelled jobs ──`);
    console.log(`Found ${orphans.rows.length} row(s):\n`);
    for (const r of orphans.rows) {
      console.log(
        `  ${r.id}  status=${r.status.padEnd(10)} job=#${r.hh_job_number || '—'} (${r.job_pipeline})  van=${r.reg || '(no vehicle)'}`
      );
    }

    if (orphans.rows.length > 0 && commit) {
      const ids = orphans.rows.map((r: any) => r.id);
      await client.query(
        `UPDATE vehicle_hire_assignments
           SET status = 'cancelled',
               status_changed_at = NOW(),
               notes = COALESCE(notes, '') ||
                       E'\n[Auto-cancelled: cleanup-orphan-assignments — job lost/cancelled, row stranded in non-terminal state]',
               updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      console.log(`\n  ✓ Cancelled ${ids.length} orphan row(s)`);

      // Re-sync fleet status for each affected unique vehicle.
      const { syncFleetHireStatus } = await import('../services/fleet-hire-status-sync');
      const vehicleIds = Array.from(new Set(orphans.rows.map((r: any) => r.vehicle_id).filter(Boolean)));
      console.log(`  ↻ Recomputing fleet hire_status for ${vehicleIds.length} vehicle(s)...`);
      for (const vid of vehicleIds) {
        try {
          const next = await syncFleetHireStatus(vid as string);
          const v = orphans.rows.find((r: any) => r.vehicle_id === vid);
          console.log(`     ${v?.reg || vid} → ${next}`);
        } catch (e) {
          console.warn(`     ${vid} sync failed:`, e);
        }
      }
    } else if (orphans.rows.length > 0) {
      console.log(`\n  (dry-run — re-run with --commit to apply)`);
    }

    // ── Class 2: booked_out / active rows without booked_out_at ───────
    const noTs = await client.query(
      `SELECT vha.id,
              vha.status,
              vha.hirehop_job_id,
              fv.reg,
              j.hh_job_number,
              j.pipeline_status AS job_pipeline
         FROM vehicle_hire_assignments vha
         LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
         LEFT JOIN jobs j
           ON (vha.job_id IS NOT NULL AND j.id = vha.job_id)
              OR (vha.job_id IS NULL AND j.hh_job_number = vha.hirehop_job_id)
        WHERE vha.status IN ('booked_out', 'active')
          AND vha.booked_out_at IS NULL
        ORDER BY vha.created_at DESC`
    );

    console.log(`\n── Class 2: booked_out / active rows with NULL booked_out_at ──`);
    console.log(`Found ${noTs.rows.length} row(s) (data integrity, no auto-fix):\n`);
    for (const r of noTs.rows) {
      console.log(
        `  ${r.id}  status=${r.status.padEnd(10)} job=#${r.hh_job_number || '—'} (${r.job_pipeline || 'no-job'})  van=${r.reg || '(none)'}`
      );
    }
    if (noTs.rows.length > 0) {
      console.log(`\n  Investigate — these shouldn't exist. A path is promoting rows`);
      console.log(`  to booked_out / active without going through book-out. Likely`);
      console.log(`  candidates: stale derivation, quick-assign, manual SQL.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
