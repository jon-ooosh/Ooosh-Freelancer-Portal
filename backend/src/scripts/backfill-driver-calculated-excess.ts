/**
 * Backfill `drivers.calculated_excess_amount` for drivers who completed the
 * hire form chain BEFORE the driver-level liability column was introduced
 * (migration 065).
 *
 * Rule: drivers with signature_date set AND requires_referral = false AND
 * calculated_excess_amount IS NULL get the standard £1,200 floor. Referral
 * drivers are SKIPPED — their calculated excess is likely above the floor
 * and needs manual review on /drivers (insurer-imposed amount).
 *
 * Locked drivers (excess_locked = true) are also skipped — that flag is a
 * deliberate "don't auto-overwrite" pin.
 *
 * Re-running is safe — only NULL values are touched.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-driver-calculated-excess.ts            # dry-run
 *   npx tsx src/scripts/backfill-driver-calculated-excess.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const STANDARD_EXCESS_PER_DRIVER = 1200;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}\n`);

    const candidates = await client.query<{
      id: string;
      full_name: string;
      email: string | null;
      requires_referral: boolean;
      signature_date: string | null;
      calculated_excess_amount: string | null;
      excess_locked: boolean;
    }>(
      `SELECT id, full_name, email, requires_referral, signature_date,
              calculated_excess_amount, excess_locked
         FROM drivers
        WHERE is_active = true
          AND signature_date IS NOT NULL
          AND calculated_excess_amount IS NULL
          AND excess_locked = false
        ORDER BY signature_date DESC`
    );

    let toUpdate = 0;
    let skippedReferral = 0;

    for (const d of candidates.rows) {
      if (d.requires_referral) {
        skippedReferral++;
        console.log(`  SKIP (referral): ${d.full_name} <${d.email || 'no email'}>`);
        continue;
      }
      toUpdate++;
      console.log(`  ${commit ? 'UPDATE' : 'WOULD'}: ${d.full_name} → £${STANDARD_EXCESS_PER_DRIVER}`);

      if (commit) {
        await client.query(
          `UPDATE drivers
              SET calculated_excess_amount = $1,
                  calculated_excess_basis  = $2,
                  updated_at = NOW()
            WHERE id = $3`,
          [STANDARD_EXCESS_PER_DRIVER, `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (backfilled)`, d.id]
        );
      }
    }

    console.log(`\nSummary`);
    console.log(`  Candidates:           ${candidates.rows.length}`);
    console.log(`  Set to £${STANDARD_EXCESS_PER_DRIVER}:    ${toUpdate}`);
    console.log(`  Skipped (referral):   ${skippedReferral}\n`);

    if (skippedReferral > 0) {
      console.log(`${skippedReferral} referral driver(s) need manual review on /drivers (set their insurer-imposed excess via the Edit modal).`);
    }

    if (!commit && toUpdate > 0) {
      console.log(`\nDry run — re-run with --commit to apply ${toUpdate} changes.`);
    } else if (commit) {
      console.log(`Applied ${toUpdate} changes.`);
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
