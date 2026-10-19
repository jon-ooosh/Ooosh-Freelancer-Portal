/**
 * Freeze the pay-direct chase ladder on Monday-IMPORTED PCNs.
 *
 * Why: the Monday import (migrate-monday-pcns.ts) maps each PCN's Monday status
 * straight through, so any historical PCN that sat in "driver notified — to pay"
 * lands in OP as status='driver_notified_pay'. The daily pay-direct chase
 * (services/pcn-chase.ts) then re-emails the CLIENT, because its only gate is:
 *
 *     status = 'driver_notified_pay'
 *       AND receipt_url IS NULL
 *       AND is_deleted = false
 *       AND pay_direct_deadline IS NOT NULL
 *
 * These old notices are long resolved in reality — they just never had their
 * status brought up to date. This script FREEZES them (stops the chaser)
 * without touching status, so staff can correct each one by hand at their own
 * pace (e.g. via the "Manual override (no email / no charge)" dropdown on the
 * PCN detail page). It does NOT email anyone.
 *
 * How the freeze works: the chaser's SELECT requires pay_direct_deadline NOT
 * NULL, so we clear pay_direct_deadline. The row drops out of the scan entirely
 * — robust regardless of chase-rung config. The cleared value is stashed in a
 * `chase_frozen` pcn_event for audit + reversal. Status, receipt_chase_level
 * and everything else are left exactly as-is.
 *
 * SCOPE — only ever touches Monday-imported rows. Provenance is the `created`
 * pcn_event the importer writes with metadata->>'source' = 'monday'. A genuine
 * live OP-created pay-direct chase (no such event) is never frozen.
 *
 * Idempotent: a row whose pay_direct_deadline is already NULL is skipped.
 *
 * Usage:
 *   npx tsx src/scripts/freeze-imported-pcn-chases.ts            # dry-run (default)
 *   npx tsx src/scripts/freeze-imported-pcn-chases.ts --commit   # apply
 *   npx tsx src/scripts/freeze-imported-pcn-chases.ts --reference OT-PCN-123 --commit
 *
 * Env: DATABASE_URL.
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const refIdx = args.indexOf('--reference');
const ONLY_REFERENCE = refIdx >= 0 ? args[refIdx + 1] : null;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // The chase-firing set, restricted to Monday-imported rows. EXISTS against
  // the importer's provenance event keeps live OP-created chases untouched.
  const { rows } = await pool.query(
    `SELECT p.id, p.reference, p.status, p.pay_direct_deadline,
            p.receipt_chase_level, fv.reg AS fleet_reg, p.vehicle_reg
       FROM pcns p
       LEFT JOIN fleet_vehicles fv ON fv.id = p.vehicle_id
      WHERE p.status = 'driver_notified_pay'
        AND p.receipt_url IS NULL
        AND p.is_deleted = false
        AND p.pay_direct_deadline IS NOT NULL
        AND ($1::text IS NULL OR p.reference = $1)
        AND EXISTS (
          SELECT 1 FROM pcn_events e
           WHERE e.pcn_id = p.id
             AND e.event_type = 'created'
             AND e.metadata->>'source' = 'monday'
        )
      ORDER BY p.reference`,
    [ONLY_REFERENCE]
  );

  console.log(`\n${COMMIT ? '🔧 COMMIT' : '🔍 DRY-RUN'} — freeze imported PCN pay-direct chases`);
  console.log(`Found ${rows.length} imported PCN(s) in the chase-firing set${ONLY_REFERENCE ? ` (reference = ${ONLY_REFERENCE})` : ''}.\n`);

  if (rows.length === 0) {
    console.log('Nothing to freeze. (Either none imported in driver_notified_pay, or already frozen.)');
    await pool.end();
    return;
  }

  for (const r of rows) {
    const reg = r.fleet_reg || r.vehicle_reg || '—';
    const deadline = r.pay_direct_deadline ? new Date(r.pay_direct_deadline).toISOString().slice(0, 10) : '—';
    console.log(`  • ${r.reference || '(no ref)'}  reg ${reg}  pay-direct deadline ${deadline}  chased ${r.receipt_chase_level || 0}×`);

    if (!COMMIT) continue;

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE pcns SET pay_direct_deadline = NULL, updated_at = NOW() WHERE id = $1`,
        [r.id]
      );
      await pool.query(
        `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
         VALUES ($1, 'chase_frozen', $2, $3, $4)`,
        [
          r.id,
          'Pay-direct chase frozen (imported historical PCN) — status unchanged, correct manually',
          JSON.stringify({ cleared_pay_direct_deadline: r.pay_direct_deadline, source: 'freeze-imported-pcn-chases' }),
          SYSTEM_USER_ID,
        ]
      );
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error(`    ✗ failed for ${r.reference}:`, (e as Error).message);
    }
  }

  console.log(
    COMMIT
      ? `\n✅ Froze ${rows.length} chase(s). Statuses are unchanged — correct each via the PCN detail page's "Manual override (no email / no charge)" dropdown.`
      : `\nDry-run only. Re-run with --commit to apply.`
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
