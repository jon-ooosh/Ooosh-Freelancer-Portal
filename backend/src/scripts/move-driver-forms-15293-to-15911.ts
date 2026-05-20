/**
 * One-off: move 3 driver hire-form submissions that landed on the wrong job.
 *
 * Background: 20 May 2026, Netlify hire-form app was briefly down. After it
 * came back up the wrong hire-form link was sent to drivers for HH job 15911,
 * pointing at HH job 15293. Three drivers submitted against 15293 when they
 * should have been on 15911:
 *   - Richard Peter Rayner
 *   - Luke Michael Oliver Caley
 *   - Marios Sozos
 * Joshua Andrew Law (also on 15293) is correctly placed — leave him alone.
 *
 * This script repoints those three drivers' `vehicle_hire_assignments` rows
 * (and any linked `job_excess` rows) from 15293 to 15911, retargets their
 * hire dates to 15911's job dates, and logs an audit interaction on both
 * jobs' timelines.
 *
 * Untouched on purpose:
 *   - `drivers` rows (driver records aren't job-scoped)
 *   - Joshua Law's assignment on 15293
 *   - Historical "hire form submitted" interactions on 15293 (accurate record;
 *     the new audit note on both timelines explains the subsequent move)
 *   - Already-sent confirmation emails (can't undo)
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/move-driver-forms-15293-to-15911.ts            # dry-run
 *   npx tsx src/scripts/move-driver-forms-15293-to-15911.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');

const SOURCE_HH = 15293;
const TARGET_HH = 15911;

// Match by last name (case-insensitive). All three are distinctive enough on
// 15293 that last-name alone is unambiguous, and crucially does NOT match
// Joshua Andrew LAW (different last name).
const DRIVER_LAST_NAMES = ['Rayner', 'Caley', 'Sozos'];

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}`);
    console.log(`Source HH job: ${SOURCE_HH}`);
    console.log(`Target HH job: ${TARGET_HH}`);
    console.log(`Drivers to move (by last name): ${DRIVER_LAST_NAMES.join(', ')}\n`);

    // ── Resolve both jobs ────────────────────────────────────────────────
    const jobs = await client.query(
      `SELECT id, hh_job_number, job_name, job_date, job_end
         FROM jobs
        WHERE hh_job_number = ANY($1::int[])`,
      [[SOURCE_HH, TARGET_HH]]
    );

    const source = jobs.rows.find((r: any) => r.hh_job_number === SOURCE_HH);
    const target = jobs.rows.find((r: any) => r.hh_job_number === TARGET_HH);

    if (!source) {
      console.error(`✗ Source job HH ${SOURCE_HH} not found in OP`);
      process.exit(1);
    }
    if (!target) {
      console.error(`✗ Target job HH ${TARGET_HH} not found in OP`);
      process.exit(1);
    }

    console.log(`Source: #${source.hh_job_number}  ${source.id}  "${source.job_name}"`);
    console.log(`        ${source.job_date?.toISOString?.()?.slice(0,10)} → ${source.job_end?.toISOString?.()?.slice(0,10)}`);
    console.log(`Target: #${target.hh_job_number}  ${target.id}  "${target.job_name}"`);
    console.log(`        ${target.job_date?.toISOString?.()?.slice(0,10)} → ${target.job_end?.toISOString?.()?.slice(0,10)}\n`);

    // ── Find assignment rows to move ─────────────────────────────────────
    const assignments = await client.query(
      `SELECT vha.id           AS assignment_id,
              vha.status,
              vha.hire_start,
              vha.hire_end,
              vha.vehicle_id,
              vha.driver_id,
              d.first_name,
              d.last_name,
              d.full_name
         FROM vehicle_hire_assignments vha
         JOIN drivers d ON d.id = vha.driver_id
        WHERE vha.hirehop_job_id = $1
          AND lower(d.last_name) = ANY($2::text[])
        ORDER BY d.last_name`,
      [SOURCE_HH, DRIVER_LAST_NAMES.map((n) => n.toLowerCase())]
    );

    console.log(`── Assignments to move (${assignments.rows.length}) ──`);
    for (const r of assignments.rows) {
      console.log(
        `  ${r.assignment_id}  ${r.full_name.padEnd(35)} status=${r.status.padEnd(10)} ` +
          `${r.hire_start?.toISOString?.()?.slice(0,10)} → ${r.hire_end?.toISOString?.()?.slice(0,10)}`
      );
    }

    if (assignments.rows.length !== DRIVER_LAST_NAMES.length) {
      console.warn(
        `\n⚠ Expected ${DRIVER_LAST_NAMES.length} assignments, found ${assignments.rows.length}. ` +
          `Investigate before committing.`
      );
    }

    const assignmentIds = assignments.rows.map((r: any) => r.assignment_id);

    // ── Find linked excess rows ──────────────────────────────────────────
    const excess = await client.query(
      `SELECT id, assignment_id, excess_status, excess_amount_required, excess_amount_taken
         FROM job_excess
        WHERE assignment_id = ANY($1::uuid[])`,
      [assignmentIds]
    );

    console.log(`\n── Linked job_excess rows (${excess.rows.length}) ──`);
    for (const r of excess.rows) {
      console.log(
        `  ${r.id}  assignment=${r.assignment_id}  status=${r.excess_status}  ` +
          `req=£${r.excess_amount_required ?? '—'}  taken=£${r.excess_amount_taken ?? '0'}`
      );
    }

    if (!commit) {
      console.log(`\n(dry-run — re-run with --commit to apply)`);
      return;
    }

    // ── Apply in a single transaction ────────────────────────────────────
    console.log(`\n── Applying changes ──`);
    await client.query('BEGIN');
    try {
      const auditNote =
        `\n[Moved ${new Date().toISOString().slice(0, 10)}: assignment moved from HH #${SOURCE_HH} to HH #${TARGET_HH} ` +
        `— wrong hire-form link sent after Netlify outage, driver completed against wrong job]`;

      const vhaUpdate = await client.query(
        `UPDATE vehicle_hire_assignments
            SET job_id = $1,
                hirehop_job_id = $2,
                hire_start = $3,
                hire_end = $4,
                notes = COALESCE(notes, '') || $5,
                updated_at = NOW()
          WHERE id = ANY($6::uuid[])
          RETURNING id`,
        [
          target.id,
          TARGET_HH,
          target.job_date,
          target.job_end,
          auditNote,
          assignmentIds,
        ]
      );
      console.log(`  ✓ Updated ${vhaUpdate.rowCount} vehicle_hire_assignments row(s)`);

      if (excess.rows.length > 0) {
        const exUpdate = await client.query(
          `UPDATE job_excess
              SET job_id = $1,
                  hirehop_job_id = $2,
                  updated_at = NOW()
            WHERE assignment_id = ANY($3::uuid[])
            RETURNING id`,
          [target.id, TARGET_HH, assignmentIds]
        );
        console.log(`  ✓ Updated ${exUpdate.rowCount} job_excess row(s)`);
      }

      // Audit interactions on both timelines so the move is visible to staff.
      const driverList = assignments.rows.map((r: any) => r.full_name).join(', ');
      const moveSummary =
        `📝 Hire-form submissions moved between jobs.\n\n` +
        `Drivers: ${driverList}.\n` +
        `These drivers were sent the wrong hire-form link after a Netlify outage and ` +
        `completed their forms against HH #${SOURCE_HH}; they actually belong on HH #${TARGET_HH}. ` +
        `Their assignment rows and any held excess have been repointed.`;

      await client.query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [
          moveSummary + `\n\n→ Moved TO job #${TARGET_HH}.`,
          source.id,
          SYSTEM_USER_ID,
        ]
      );
      await client.query(
        `INSERT INTO interactions (type, content, job_id, created_by)
         VALUES ('note', $1, $2, $3)`,
        [
          moveSummary + `\n\n← Moved FROM job #${SOURCE_HH}.`,
          target.id,
          SYSTEM_USER_ID,
        ]
      );
      console.log(`  ✓ Logged audit interactions on both job timelines`);

      await client.query('COMMIT');
      console.log(`\n✓ Done. Verify on Job Detail for both #${SOURCE_HH} and #${TARGET_HH}.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
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
