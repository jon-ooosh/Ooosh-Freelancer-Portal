/**
 * Backfill `fleet_vehicles.hire_status` from current assignment state.
 *
 * Run once after deploying the fleet-hire-status-sync centralisation.
 * Recomputes every fleet vehicle's `hire_status` using the same rules
 * the runtime sync helper uses, catching any drift that accumulated
 * before the centralised write paths were in place.
 *
 * Sticky values ('Sold', 'Not Ready') are preserved.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-fleet-hire-status.ts            # dry-run
 *   npx tsx src/scripts/backfill-fleet-hire-status.ts --commit   # apply
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

    const all = await client.query(
      `SELECT id, reg, hire_status FROM fleet_vehicles ORDER BY reg`,
    );

    let preservedCount = 0;
    let unchangedCount = 0;
    let changedCount = 0;
    const changes: Array<{ reg: string; from: string; to: string }> = [];

    for (const row of all.rows) {
      const currentStatus = (row.hire_status as string) || 'Available';

      if (currentStatus === 'Sold' || currentStatus === 'Not Ready') {
        preservedCount++;
        continue;
      }

      const activeCount = await client.query(
        `SELECT COUNT(*)::int AS c
           FROM vehicle_hire_assignments
          WHERE vehicle_id = $1
            AND status IN ('booked_out', 'active')`,
        [row.id],
      );
      const hasActive = activeCount.rows[0].c > 0;

      let nextStatus: string;
      if (hasActive) {
        nextStatus = 'On Hire';
      } else if (currentStatus === 'On Hire') {
        nextStatus = 'Prep Needed';
      } else {
        nextStatus = currentStatus;
      }

      if (nextStatus === currentStatus) {
        unchangedCount++;
        continue;
      }

      changedCount++;
      changes.push({ reg: row.reg, from: currentStatus, to: nextStatus });

      if (commit) {
        await client.query(
          `UPDATE fleet_vehicles SET hire_status = $1, updated_at = NOW() WHERE id = $2`,
          [nextStatus, row.id],
        );
      }
    }

    console.log(`Total vehicles:    ${all.rows.length}`);
    console.log(`Sticky (skipped):  ${preservedCount}`);
    console.log(`Unchanged:         ${unchangedCount}`);
    console.log(`Changed:           ${changedCount}\n`);

    if (changes.length > 0) {
      console.log('Changes:');
      for (const c of changes) {
        console.log(`  ${c.reg}: ${c.from} → ${c.to}`);
      }
    }

    if (!commit && changedCount > 0) {
      console.log(`\nDry run — re-run with --commit to apply ${changedCount} changes.`);
    } else if (commit) {
      console.log(`\nApplied ${changedCount} changes.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
