/**
 * One-off: record in OP an excess refund that was made directly in HireHop as a
 * payment application ("Payment - xs refund …"), which no reconciler picks up.
 * For hires done before OP — jobs 12150 and 15145 (Nov 2026). Goes through
 * services/excess-refund.ts unwindRefundOnExcess(), the same path the Money tab
 * uses for HireHop refunds of the older shape: a refund leg, the status, notes.
 * OP ONLY — nothing is sent to HireHop, Stripe or Xero, and no email.
 *
 * Run the excess claim sweep FIRST (scripts/sweep-excess-claims.ts --run), so
 * any part applied to the invoice is already a claim; otherwise a fully used
 * excess ends as "partially reimbursed" instead of closed.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/record-hh-excess-refund.ts --job=15145 --amount=153.02           # show, change nothing
 *   npx tsx src/scripts/record-hh-excess-refund.ts --job=15145 --amount=153.02 --run     # record it
 *   --excess=<uuid>   pick the record when the job has more than one
 *
 * Safe to re-run: the refund leg's reference is fixed for a job + amount, so a
 * second --run is skipped as a duplicate.
 */
import dotenv from 'dotenv';
import { query, getPool } from '../config/database';
import { unwindRefundOnExcess } from '../services/excess-refund';

dotenv.config();

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

async function main() {
  const hh = Number(arg('job'));
  const amount = Math.round(Number(arg('amount')) * 100) / 100;
  if (!Number.isInteger(hh) || hh <= 0 || !(amount > 0)) {
    console.error('Give --job=<HireHop job number> and --amount=<refund £>.');
    process.exitCode = 1;
    return;
  }
  const r = await query(
    `SELECT je.id, je.excess_status, je.excess_amount_taken, je.claim_amount, je.reimbursement_amount,
            je.hh_deposit_id, h.held_amount
     FROM job_excess je
     JOIN jobs j ON j.id = je.job_id
     LEFT JOIN v_excess_held h ON h.excess_id = je.id
     WHERE j.hh_job_number = $1
       AND je.excess_status NOT IN ('waived', 'not_required', 'rolled_over', 'released')
     ORDER BY je.created_at`,
    [hh],
  );
  const rows = r.rows as Array<Record<string, string | null>>;
  const pick = arg('excess') ? rows.filter((x) => x.id === arg('excess')) : rows;
  for (const x of rows) {
    console.log(`  excess ${x.id}: ${x.excess_status} · taken £${x.excess_amount_taken ?? 0} · claimed £${x.claim_amount ?? 0} · reimbursed £${x.reimbursement_amount ?? 0} · held £${x.held_amount ?? 0} · HH deposit ${x.hh_deposit_id ?? '—'}`);
  }
  if (pick.length !== 1) {
    console.error(pick.length === 0 ? `No excess record found for job ${hh}.` : `Job ${hh} has ${pick.length} records — say which with --excess=<id>.`);
    process.exitCode = 1;
    return;
  }
  const rec = pick[0];
  const held = Number(rec.held_amount || 0);
  console.log(`Would record a £${amount.toFixed(2)} refund made in HireHop on excess ${rec.id}: held £${held.toFixed(2)} → £${Math.max(held - amount, 0).toFixed(2)}.`);
  if (amount > held + 0.005) console.log(`Note: that is more than OP shows held — only £${held.toFixed(2)} would be recorded.`);
  if (!process.argv.includes('--run')) {
    console.log('Nothing changed. Add --run to record it.');
    return;
  }
  const res = await unwindRefundOnExcess({
    excessId: String(rec.id),
    amount,
    source: 'hh_reconcile',
    sourceRef: `hh_manual_refund_${hh}_${Math.round(amount * 100)}`,
    method: null,
    notes: 'refund made directly in HireHop before OP, recorded by scripts/record-hh-excess-refund.ts',
  });
  console.log(res.updated ? `Done: status now ${res.newStatus}.` : `Not changed: ${res.reason}.`);
}

main()
  .then(async () => { await getPool().end(); })
  .catch(async (err) => { console.error('Failed:', err); await getPool().end().catch(() => undefined); process.exitCode = 1; });
