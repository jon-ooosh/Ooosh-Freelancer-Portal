/**
 * Read-only PREVIEW of a vehicle swap. Makes ZERO writes — every query is a
 * SELECT. Lets you verify exactly what `POST /api/assignments/:id/swap-vehicle`
 * WOULD do against real data without creating any junk events / rows.
 *
 * It exercises the real targeting logic:
 *   - the multi-driver cascade query (which assignments would move)
 *   - findOverlappingAssignments() — the SAME service the endpoint uses for
 *     the availability gate, so a "would this be blocked?" answer is faithful
 *   - the open-issues lookup (what could be linked) + excess that would copy
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/preview-vehicle-swap.ts --assignment=<uuid> [--to=<REG|uuid>]
 *
 * --assignment  the booked_out/active assignment you'd click "Swap" on
 * --to          (optional) the replacement van reg or id — needed to run the
 *               availability gate. Omit to just see the cascade + issue plan.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { findOverlappingAssignments } from '../services/assignment-overlap';

dotenv.config();

const assignmentArg = process.argv.find(a => a.startsWith('--assignment='))?.split('=')[1];
const toArg = process.argv.find(a => a.startsWith('--to='))?.split('=')[1];

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  if (!assignmentArg) { console.error('Required: --assignment=<uuid>'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    // 1. Load the target assignment (the row you'd click Swap on).
    const origRes = await client.query(
      `SELECT a.*, fv.reg AS vehicle_reg, d.full_name AS driver_name
         FROM vehicle_hire_assignments a
         LEFT JOIN fleet_vehicles fv ON fv.id = a.vehicle_id
         LEFT JOIN drivers d ON d.id = a.driver_id
        WHERE a.id = $1`,
      [assignmentArg]
    );
    if (origRes.rows.length === 0) { console.error('Assignment not found'); process.exit(1); }
    const orig = origRes.rows[0];

    console.log(`\n══ SWAP PREVIEW (read-only — no writes) ══\n`);
    console.log(`Target assignment : ${orig.id}`);
    console.log(`Current van       : ${orig.vehicle_reg || '(none)'}`);
    console.log(`Driver            : ${orig.driver_name || '(none)'}`);
    console.log(`Status            : ${orig.status}`);
    console.log(`Job               : OP ${orig.job_id || '—'} / HH #${orig.hirehop_job_id || '—'}`);
    console.log(`ve103b_ref        : ${orig.ve103b_ref || '(none)'}`);

    if (['cancelled', 'swapped'].includes(orig.status)) {
      console.log(`\n⚠ This assignment is '${orig.status}' — the endpoint would 404 (already terminal).`);
    }
    if (!['booked_out', 'active'].includes(orig.status)) {
      console.log(`\nℹ Note: the Swap button only shows on booked_out/active cards. This row is '${orig.status}'.`);
    }

    // 2. Multi-driver cascade — mirrors the endpoint's slot query exactly.
    const slotRes = await client.query(
      `SELECT a.id, a.status, a.driver_id, a.ve103b_ref, d.full_name AS driver_name
         FROM vehicle_hire_assignments a
         LEFT JOIN drivers d ON d.id = a.driver_id
        WHERE a.vehicle_id = $1
          AND a.status IN ('soft', 'confirmed', 'booked_out', 'active')
          AND ( ($2::uuid IS NOT NULL AND a.job_id = $2::uuid)
             OR ($3::integer IS NOT NULL AND a.hirehop_job_id = $3::integer) )
        ORDER BY a.created_at`,
      [orig.vehicle_id, orig.job_id ?? null, orig.hirehop_job_id ?? null]
    );
    console.log(`\n── Cascade: ${slotRes.rows.length} assignment(s) would move to the new van ──`);
    for (const r of slotRes.rows) {
      console.log(`  ${r.id}  ${String(r.status).padEnd(10)} driver=${r.driver_name || '(none)'}${r.ve103b_ref ? '  [has VE103B]' : ''}`);
    }
    const ve103bRows = slotRes.rows.filter((r: any) => r.ve103b_ref);
    if (ve103bRows.length > 0) {
      console.log(`  → ve103b_regen_needed = TRUE (${ve103bRows.length} row(s)) — staff prompted to regenerate manually`);
    }

    // 3. Excess that would copy to each new assignment.
    const ids = slotRes.rows.map((r: any) => r.id);
    if (ids.length > 0) {
      const exRes = await client.query(
        `SELECT assignment_id, excess_amount_required, excess_status
           FROM job_excess WHERE assignment_id = ANY($1::uuid[])`,
        [ids]
      );
      console.log(`\n── Excess: ${exRes.rows.length} record(s) would MOVE to the replacement (re-pointed, not duplicated) ──`);
      for (const e of exRes.rows) {
        console.log(`  assignment ${e.assignment_id}: £${e.excess_amount_required} (${e.excess_status})`);
      }
    }

    // 4. Open issues on the old van (what the modal would offer to link).
    const issuesRes = await client.query(
      `SELECT id, summary, category, severity, status
         FROM job_issues
        WHERE vehicle_id = $1 AND status NOT IN ('resolved', 'written_off', 'cancelled')
        ORDER BY created_at DESC`,
      [orig.vehicle_id]
    );
    console.log(`\n── Open issues on ${orig.vehicle_reg} (modal would default to the first, else create new) ──`);
    if (issuesRes.rows.length === 0) {
      console.log(`  (none) → modal defaults to "create a new breakdown issue"`);
    } else {
      for (const i of issuesRes.rows) {
        console.log(`  ${i.id}  [${i.category}/${i.severity}] ${i.summary.slice(0, 60)}`);
      }
    }

    // 5. Availability gate — the SAME service the endpoint uses. Resolve --to.
    if (toArg) {
      let newVehicleId = toArg;
      let newReg = toArg;
      const looksUuid = /^[0-9a-f-]{36}$/i.test(toArg);
      const vres = await client.query(
        looksUuid ? `SELECT id, reg FROM fleet_vehicles WHERE id = $1`
                  : `SELECT id, reg FROM fleet_vehicles WHERE reg = $1`,
        [looksUuid ? toArg : toArg.toUpperCase()]
      );
      if (vres.rows.length === 0) {
        console.log(`\n── Availability ──\n  ⚠ Replacement '${toArg}' not found in fleet.`);
      } else {
        newVehicleId = vres.rows[0].id;
        newReg = vres.rows[0].reg;
        const conflicts = await findOverlappingAssignments({
          vehicleId: newVehicleId,
          hireStart: orig.hire_start,
          hireEnd: orig.hire_end,
          jobId: orig.job_id,
          hirehopJobId: orig.hirehop_job_id,
        });
        console.log(`\n── Availability gate for ${newReg} ──`);
        if (conflicts.length === 0) {
          console.log(`  ✓ Available — swap would PROCEED.`);
        } else {
          console.log(`  ✗ BLOCKED (409) — ${newReg} clashes with:`);
          for (const c of conflicts) {
            console.log(`     job #${c.hhJobNumber || c.jobName} (${c.effectiveStart} → ${c.effectiveEnd}) status=${c.status}`);
          }
        }
      }
    } else {
      console.log(`\n── Availability ──\n  (pass --to=<REG> to run the availability gate against a replacement)`);
    }

    // 6. Summary of side-effects the endpoint WOULD apply (none applied here).
    console.log(`\n── On confirm, the endpoint WOULD ──`);
    console.log(`  • mark ${slotRes.rows.length} row(s) status='swapped', create ${slotRes.rows.length} new 'confirmed' row(s) on the new van`);
    console.log(`  • set ${orig.vehicle_reg} fleet hire_status → 'Not Ready'`);
    console.log(`  • link/create a Problems issue + log a 'swap_logged' event`);
    console.log(`  • post an HH job memo note + a 🔄 job-timeline interaction`);
    console.log(`  • redirect staff to BookOut for the replacement van`);
    console.log(`\n(Nothing above was written — this was a preview.)\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
