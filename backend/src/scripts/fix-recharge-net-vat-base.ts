/**
 * Fix stale recharge rows whose base was captured as net MINUS VAT.
 *
 * An interim Cost Capture build wrote flagged recharges as recharge_mode='partial'
 * with recharge_amount = amount_net − amount_vat (i.e. the net accidentally
 * stripped of its own VAT, = net × 0.8). The resolve modal reads that as the
 * base, so the marked-up figure landed at ~break-even (a loss, not a markup).
 * Current `main` capture code doesn't do this — but the bad rows persist.
 *
 * SAFE: direct DB update only — NO HireHop pushes, NO Xero, NO emails. It only
 * resets the OP recharge base so the row reopens with the correct net.
 *
 * Candidate rule (conservative — the clearly-buggy, not-yet-actioned set):
 *   - recharge_mode = 'partial'
 *   - recharge_status = 'pending'         (never resolved)
 *   - recharged_to_hh_at IS NULL          (never pushed to HireHop)
 *   - recharge_base_amount IS NULL        (never went through the resolve modal)
 *   - amount_net & amount_vat present
 *   - recharge_amount ≈ amount_net − amount_vat  (the net×0.8 signature, ±1p)
 *
 * Each match → recharge_mode='full', recharge_amount=NULL, so the resolve modal
 * falls back to the cost's real net (amount_net) as the base. Status/links left
 * untouched. Rows that have been pushed, resolved, or hand-edited are ignored.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/fix-recharge-net-vat-base.ts            # dry-run (no writes)
 *   npx tsx src/scripts/fix-recharge-net-vat-base.ts --commit   # apply
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');

const CANDIDATE_WHERE = `
  recharge_mode = 'partial'
  AND COALESCE(recharge_status, 'pending') = 'pending'
  AND recharged_to_hh_at IS NULL
  AND recharge_base_amount IS NULL
  AND amount_net IS NOT NULL
  AND amount_vat IS NOT NULL
  AND recharge_amount IS NOT NULL
  AND ABS(recharge_amount - (amount_net - amount_vat)) <= 0.01
`;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, supplier_name, description, amount_gross, amount_net, amount_vat, recharge_amount
         FROM costs
        WHERE ${CANDIDATE_WHERE}
        ORDER BY cost_date DESC NULLS LAST`,
    );

    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}\n`);
    console.log(`Stale net-minus-VAT recharge rows: ${rows.length}\n`);
    for (const r of rows) {
      const correctNet = Number(r.amount_net).toFixed(2);
      console.log(
        `  ${r.supplier_name ?? '—'}  "${(r.description ?? '').slice(0, 32)}"  ` +
        `gross £${Number(r.amount_gross ?? 0).toFixed(2)}  ` +
        `bad base £${Number(r.recharge_amount).toFixed(2)} → correct net £${correctNet}  (id ${r.id})`,
      );
    }

    if (!rows.length) { console.log('Nothing to fix.'); return; }
    if (!commit) { console.log('\nDry run — re-run with --commit to apply.'); return; }

    const upd = await client.query(
      `UPDATE costs
          SET recharge_mode = 'full', recharge_amount = NULL
        WHERE ${CANDIDATE_WHERE}`,
    );
    console.log(`\n✓ Reset ${upd.rowCount} row(s) to recharge_mode='full', recharge_amount=NULL.`);
    console.log("  They'll reopen in the resolve modal with the correct net base.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
