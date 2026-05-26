/**
 * Clean up orphaned dual-row `vehicle_hire_assignments`.
 *
 * The dual-row pattern: a self-drive hire can carry two rows for the same
 * `(vehicle_id, hirehop_job_id)`:
 *   - Staff-allocation row — from AllocationsPage. `driver_id` NULL,
 *     `vehicle_id` set, status 'confirmed', no `booked_out_at`.
 *   - Hire-form row — from POST /api/hire-forms. `driver_id` set, progresses
 *     through `booked_out` → `returned`.
 *
 * The live dedup (services/vha-dedup.ts) now cancels the staff-allocation
 * sibling at book-out time. This script cleans up HISTORICAL orphans created
 * before that fix — rows that still sit in 'soft'/'confirmed' and keep
 * "occupying" their van in overlap checks, blocking future allocations +
 * swaps (the 15 May 2026 HLU/15613 incident).
 *
 * Detection: a row is an orphan when
 *   - status IN ('soft', 'confirmed')
 *   - booked_out_at IS NULL          (never physically went out)
 *   - driver_id IS NULL              (PURE allocation — protects multi-driver
 *                                     hires where a 2nd DRIVER shares the van)
 *   - vehicle_id + hirehop_job_id both set
 *   - AND a sibling row exists on the same (vehicle, job) with
 *     booked_out_at NOT NULL        (the row that actually progressed)
 *
 * Soft-cancel only (status='cancelled' + audit note) — never a physical
 * DELETE (CLAUDE.md "vehicle_hire_assignments is soft-cancel only").
 * Idempotent: re-running skips already-cancelled rows (status guard).
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/cleanup-orphan-vha-rows.ts                  # dry-run, full fleet
 *   npx tsx src/scripts/cleanup-orphan-vha-rows.ts --commit         # apply
 *   npx tsx src/scripts/cleanup-orphan-vha-rows.ts --vehicle=RO23HLU
 *   npx tsx src/scripts/cleanup-orphan-vha-rows.ts --job=15613
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const vehicleArg = process.argv.find(a => a.startsWith('--vehicle='))?.split('=')[1]?.toUpperCase();
const jobArg = process.argv.find(a => a.startsWith('--job='))?.split('=')[1];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}`);
    if (vehicleArg) console.log(`Filter: vehicle = ${vehicleArg}`);
    if (jobArg) console.log(`Filter: job = ${jobArg}`);
    console.log('');

    const orphans = await client.query(
      `SELECT orphan.id,
              orphan.status,
              orphan.vehicle_id,
              orphan.hirehop_job_id,
              orphan.job_id,
              orphan.created_at,
              fv.reg,
              sibling.id           AS sibling_id,
              sibling.status       AS sibling_status,
              sibling.booked_out_at AS sibling_booked_out_at
         FROM vehicle_hire_assignments orphan
         JOIN vehicle_hire_assignments sibling
           ON sibling.vehicle_id = orphan.vehicle_id
          AND sibling.hirehop_job_id = orphan.hirehop_job_id
          AND sibling.id != orphan.id
          AND sibling.booked_out_at IS NOT NULL
         LEFT JOIN fleet_vehicles fv ON fv.id = orphan.vehicle_id
        WHERE orphan.status IN ('soft', 'confirmed')
          AND orphan.booked_out_at IS NULL
          AND orphan.driver_id IS NULL
          AND orphan.vehicle_id IS NOT NULL
          AND orphan.hirehop_job_id IS NOT NULL
          AND ($1::text IS NULL OR fv.reg = $1::text)
          AND ($2::integer IS NULL OR orphan.hirehop_job_id = $2::integer)
        ORDER BY orphan.hirehop_job_id, orphan.created_at`,
      [vehicleArg || null, jobArg ? parseInt(jobArg, 10) : null]
    );

    console.log(`Found ${orphans.rows.length} orphan row(s):\n`);
    for (const r of orphans.rows) {
      console.log(
        `  ${r.id}  status=${String(r.status).padEnd(10)} van=${(r.reg || '(none)').padEnd(10)} ` +
        `job=#${r.hirehop_job_id}  → superseded by ${r.sibling_id} (${r.sibling_status})`
      );
    }

    if (orphans.rows.length === 0) {
      console.log('  Nothing to clean up.');
      return;
    }

    if (!commit) {
      console.log(`\n  (dry-run — re-run with --commit to apply)`);
      return;
    }

    const ids = orphans.rows.map((r: any) => r.id);
    await client.query(
      `UPDATE vehicle_hire_assignments
         SET status = 'cancelled',
             status_changed_at = NOW(),
             notes = COALESCE(notes, '') ||
                     CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END ||
                     E'[Sweeper: orphan staff-allocation row, sibling progressed through book-out — cleanup-orphan-vha-rows]',
             updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    console.log(`\n  ✓ Cancelled ${ids.length} orphan row(s)`);

    // Re-sync fleet status for each affected unique vehicle so the cached
    // projection reflects the cleanup immediately.
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
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
