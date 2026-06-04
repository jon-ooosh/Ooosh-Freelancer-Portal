/**
 * Reconcile stale excess — clears the backlog of excess that was collected on
 * hires which have long finished and (per ops) been returned in reality, but
 * was never marked reimbursed in OP (pre-OP hires, returns handled in HireHop,
 * etc.). These inflate the "Excess Held" figures.
 *
 * SAFE: this is a direct DB update — it does NOT call any of the excess
 * endpoints, so NO client emails, NO HireHop pushes, NO Stripe calls fire. It
 * only sets the OP record's status/reimbursement so the held figures reflect
 * reality.
 *
 * Conservative candidate rule (the clearly-stale, clearly-safe set):
 *   - status IN ('taken','partially_paid')   — money shown as held
 *   - claim_amount = 0                        — NO damage claim (those are live
 *                                               cases; never auto-close them)
 *   - hire finished 5+ days ago
 *   - canonical held_amount > 0
 * Records with claims, pre_auth holds, or partial reimbursements are LEFT for
 * manual review (reported separately, never auto-committed).
 *
 * Each reconciled record → excess_status='reimbursed',
 * reimbursement_amount tops up to excess_amount_taken (so canonical held → 0),
 * reimbursement_method='reconciled_stale', a dated marker appended to notes.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/reconcile-stale-excess.ts             # dry-run (no writes)
 *   npx tsx src/scripts/reconcile-stale-excess.ts --commit    # apply
 *   npx tsx src/scripts/reconcile-stale-excess.ts --days=14   # finished N+ days ago (default 5)
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 5;

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const candidates = await client.query(
      `SELECT je.id, je.excess_status, je.client_name,
              COALESCE(je.excess_amount_taken,0) AS taken,
              COALESCE(je.reimbursement_amount,0) AS reimbursed,
              j.hh_job_number,
              COALESCE(j.return_date, j.job_end)::date AS finished,
              GREATEST(COALESCE(je.excess_amount_taken,0) + COALESCE(je.amount_held,0)
                       - COALESCE(je.claim_amount,0) - COALESCE(je.reimbursement_amount,0), 0) AS held
       FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.excess_status IN ('taken','partially_paid')
         AND COALESCE(je.claim_amount,0) = 0
         AND COALESCE(je.amount_held,0) = 0
         AND COALESCE(j.return_date, j.job_end)::date <= CURRENT_DATE - ($1 || ' days')::interval
         AND GREATEST(COALESCE(je.excess_amount_taken,0) + COALESCE(je.amount_held,0)
                      - COALESCE(je.claim_amount,0) - COALESCE(je.reimbursement_amount,0), 0) > 0.01
       ORDER BY finished ASC`,
      [String(days)]
    );

    // Excluded-but-flagged: claims or partial reimbursements on finished hires
    // — needs human eyes, never auto-committed.
    const review = await client.query(
      `SELECT je.id, je.excess_status, je.client_name, j.hh_job_number,
              COALESCE(je.excess_amount_taken,0) AS taken,
              COALESCE(je.claim_amount,0) AS claimed,
              COALESCE(je.reimbursement_amount,0) AS reimbursed
       FROM job_excess je
       LEFT JOIN jobs j ON j.id = je.job_id
       WHERE je.excess_status IN ('taken','partially_paid','partially_reimbursed')
         AND (COALESCE(je.claim_amount,0) > 0 OR je.excess_status = 'partially_reimbursed')
         AND COALESCE(j.return_date, j.job_end)::date <= CURRENT_DATE - ($1 || ' days')::interval`,
      [String(days)]
    );

    const total = candidates.rows.reduce((a, r) => a + parseFloat(r.held), 0);
    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'} — finished ${days}+ days ago\n`);
    console.log(`Auto-reconcile candidates: ${candidates.rows.length} records, £${total.toFixed(2)} held\n`);
    for (const r of candidates.rows) {
      console.log(`  #${r.hh_job_number ?? '—'}  ${r.client_name ?? '—'}  ${r.excess_status}  £${parseFloat(r.held).toFixed(2)}  finished ${r.finished?.toISOString?.().slice(0,10) ?? r.finished}`);
    }
    if (review.rows.length > 0) {
      console.log(`\n⚠ ${review.rows.length} record(s) NOT auto-reconciled (claims / partial reimbursements) — review manually:`);
      for (const r of review.rows) {
        console.log(`  #${r.hh_job_number ?? '—'}  ${r.client_name ?? '—'}  ${r.excess_status}  taken £${parseFloat(r.taken).toFixed(2)}  claimed £${parseFloat(r.claimed).toFixed(2)}  reimbursed £${parseFloat(r.reimbursed).toFixed(2)}`);
      }
    }

    if (!commit) { console.log('\nDry run — re-run with --commit to apply.'); return; }

    let updated = 0;
    for (const r of candidates.rows) {
      await client.query(
        `UPDATE job_excess
         SET excess_status = 'reimbursed',
             reimbursement_amount = COALESCE(excess_amount_taken, 0),
             reimbursement_date = NOW(),
             reimbursement_method = 'reconciled_stale',
             notes = COALESCE(notes, '') || ' [Auto-reconciled stale excess ' || to_char(NOW(), 'YYYY-MM-DD') || ']',
             updated_at = NOW()
         WHERE id = $1`,
        [r.id]
      );
      updated++;
    }
    console.log(`\nReconciled ${updated} record(s), £${total.toFixed(2)} cleared from "held".`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
