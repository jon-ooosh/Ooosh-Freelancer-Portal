/**
 * Backfill `job_excess.excess_amount_required` for records left at NULL by
 * the pre-fix `POST /api/hire-forms` insert path.
 *
 * Before the fix, second-onwards drivers on a job (those who couldn't absorb
 * an unlinked derivation-engine record) had their excess inserted with
 * whatever the hire form app sent — typically NULL/0 for clean-licence
 * drivers expecting the OP to apply the £1,200 floor. This left their
 * individual liability invisible on the Drivers page and unblockable on
 * the dispatch gate.
 *
 * Backfill rules per affected job:
 *   1. Read derived van count from jobs.hh_derived_flags.self_drive_count
 *      (default 1).
 *   2. Order the job's active excess records by created_at ASC. Active =
 *      assignment_id IS NOT NULL AND excess_status NOT IN (reimbursed,
 *      fully_claimed, rolled_over, not_required, waived).
 *   3. Position 1..N (van count): if amount is NULL and linked driver is
 *      NOT a referral, set excess_amount_required = 1200 and keep status.
 *   4. Position N+1..: if amount is NULL, set excess_amount_required = 0
 *      and excess_status = 'not_required' (covered by another driver's
 *      excess on this hire).
 *   5. Referral drivers with NULL amount are SKIPPED — flagged for manual
 *      review since their calculated excess is likely above the floor.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-null-excess.ts            # dry-run
 *   npx tsx src/scripts/backfill-null-excess.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const STANDARD_EXCESS_PER_DRIVER = 1200;

interface ExcessRow {
  id: string;
  job_id: string;
  hirehop_job_id: number | null;
  assignment_id: string;
  driver_id: string | null;
  driver_name: string | null;
  requires_referral: boolean;
  excess_amount_required: string | null;
  excess_status: string;
  created_at: string;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}\n`);

    // Find every job that has at least one active record with NULL amount.
    const affectedJobs = await client.query<{ job_id: string; hh_job_number: number | null; van_count: number }>(
      `SELECT DISTINCT je.job_id,
              j.hh_job_number,
              COALESCE((j.hh_derived_flags->>'self_drive_count')::int, 1) AS van_count
       FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.excess_amount_required IS NULL
         AND je.assignment_id IS NOT NULL
         AND je.excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'waived')
       ORDER BY je.job_id`
    );

    console.log(`Affected jobs: ${affectedJobs.rows.length}\n`);

    let setToFloor = 0;
    let setToNotRequired = 0;
    let skippedReferral = 0;
    const changes: Array<{ jobNumber: number | null; driverName: string | null; from: string; to: string; reason: string }> = [];

    for (const job of affectedJobs.rows) {
      // Pull every active record on this job, oldest first. Includes records
      // that already have amounts (paid/taken) so position counting matches
      // the runtime first-N-assigned rule.
      const records = await client.query<ExcessRow>(
        `SELECT je.id,
                je.job_id,
                je.hirehop_job_id,
                je.assignment_id,
                vha.driver_id,
                d.full_name AS driver_name,
                COALESCE(d.requires_referral, false) AS requires_referral,
                je.excess_amount_required,
                je.excess_status,
                je.created_at
         FROM job_excess je
         JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
         LEFT JOIN drivers d ON d.id = vha.driver_id
         WHERE je.job_id = $1
           AND je.excess_status NOT IN ('reimbursed', 'fully_claimed', 'rolled_over', 'not_required', 'waived')
         ORDER BY je.created_at ASC`,
        [job.job_id]
      );

      const vanCount = Math.max(job.van_count, 1);
      const jobLabel = job.hh_job_number ? `#${job.hh_job_number}` : job.job_id;
      console.log(`Job ${jobLabel}: ${records.rows.length} active records, van count ${vanCount}`);

      for (let i = 0; i < records.rows.length; i++) {
        const rec = records.rows[i];
        const position = i + 1;
        const isWithinTopN = position <= vanCount;

        // Only touch records that have NULL amount.
        if (rec.excess_amount_required !== null) {
          continue;
        }

        // Referral drivers — skip, flag for manual review.
        if (rec.requires_referral) {
          skippedReferral++;
          console.log(`  [${position}/${vanCount}] ${rec.driver_name || '?'}: SKIP (referral — manual review needed)`);
          continue;
        }

        if (isWithinTopN) {
          setToFloor++;
          changes.push({
            jobNumber: job.hh_job_number,
            driverName: rec.driver_name,
            from: 'NULL / pending',
            to: `£${STANDARD_EXCESS_PER_DRIVER} / ${rec.excess_status}`,
            reason: `position ${position}/${vanCount}, standard floor`,
          });
          console.log(`  [${position}/${vanCount}] ${rec.driver_name || '?'}: NULL → £${STANDARD_EXCESS_PER_DRIVER} (within top-N)`);

          if (commit) {
            await client.query(
              `UPDATE job_excess SET
                excess_amount_required = $1,
                excess_calculation_basis = COALESCE(NULLIF(excess_calculation_basis, ''), $2),
                notes = COALESCE(notes, '') || E'\nBackfilled to £' || $1 || ' (standard floor, position ' || $3 || '/' || $4 || ')',
                updated_at = NOW()
              WHERE id = $5`,
              [STANDARD_EXCESS_PER_DRIVER, `Standard £${STANDARD_EXCESS_PER_DRIVER.toLocaleString()} floor (backfilled)`, position, vanCount, rec.id]
            );
          }
        } else {
          setToNotRequired++;
          changes.push({
            jobNumber: job.hh_job_number,
            driverName: rec.driver_name,
            from: 'NULL / pending',
            to: '£0 / not_required',
            reason: `position ${position}/${vanCount}, covered by another driver`,
          });
          console.log(`  [${position}/${vanCount}] ${rec.driver_name || '?'}: NULL → £0 not_required (covered)`);

          if (commit) {
            await client.query(
              `UPDATE job_excess SET
                excess_amount_required = 0,
                excess_status = 'not_required',
                excess_calculation_basis = COALESCE(NULLIF(excess_calculation_basis, ''), $1),
                notes = COALESCE(notes, '') || E'\nBackfilled to not_required (additional driver ' || $2 || ' on ' || $3 || '-van job)',
                updated_at = NOW()
              WHERE id = $4`,
              [`Additional driver ${position} on ${vanCount}-van job — covered by another driver's excess`, position, vanCount, rec.id]
            );
          }
        }
      }
    }

    console.log(`\nSummary`);
    console.log(`  Set to £${STANDARD_EXCESS_PER_DRIVER}:    ${setToFloor}`);
    console.log(`  Set to not_required:  ${setToNotRequired}`);
    console.log(`  Skipped (referral):   ${skippedReferral}`);
    console.log(`  Total changes:        ${setToFloor + setToNotRequired}\n`);

    if (skippedReferral > 0) {
      console.log(`${skippedReferral} referral driver(s) need manual review on /money/excess.`);
    }

    if (!commit && (setToFloor + setToNotRequired) > 0) {
      console.log(`\nDry run — re-run with --commit to apply ${setToFloor + setToNotRequired} changes.`);
    } else if (commit) {
      console.log(`Applied ${setToFloor + setToNotRequired} changes.`);
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
