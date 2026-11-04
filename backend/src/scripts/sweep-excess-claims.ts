/**
 * One-off: refresh the Money tab summary of every job where OP still counts
 * excess as held in cash, so the HireHop claim catch-up
 * (services/excess-hh-claims.ts, Money tab Pass 3) records any excess that was
 * applied to an invoice directly in HireHop. Job 16325, Nov 2026.
 *
 * The nightly job-financials refresh reaches these jobs anyway (300 a night,
 * stalest first); this just does them all now.
 *
 * IMPORTANT: the backend server must be RUNNING — like backfill-job-financials.ts
 * this drives the live /api/money/:hh/summary endpoint over localhost.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/sweep-excess-claims.ts              # list the jobs, change nothing
 *   npx tsx src/scripts/sweep-excess-claims.ts --run        # refresh them, 3s apart
 */
import dotenv from 'dotenv';
import { query, getPool } from '../config/database';
import { backfillJobFinancials } from '../services/job-financials-backfill';

dotenv.config();

async function main() {
  const r = await query(
    `SELECT DISTINCT j.hh_job_number, COALESCE(j.client_name, j.company_name) AS client,
            SUM(GREATEST(h.held_amount - COALESCE(je.amount_held, 0), 0)) OVER (PARTITION BY j.id) AS cash_held
     FROM v_excess_held h
     JOIN job_excess je ON je.id = h.excess_id
     JOIN jobs j ON j.id = je.job_id
     WHERE h.held_amount - COALESCE(je.amount_held, 0) > 0.01
       AND je.hh_deposit_id IS NOT NULL
       AND j.hh_job_number IS NOT NULL
     ORDER BY j.hh_job_number`,
  );
  const jobs = r.rows as Array<{ hh_job_number: number; client: string; cash_held: string }>;
  for (const j of jobs) console.log(`  #${j.hh_job_number}  ${j.client || ''}  £${Number(j.cash_held).toFixed(2)} held`);
  console.log(`${jobs.length} job(s) with excess held in cash and linked to HireHop.`);
  if (!process.argv.includes('--run')) {
    console.log('Nothing changed. Add --run to refresh them.');
    return;
  }
  const res = await backfillJobFinancials({ hhJobNumbers: jobs.map((j) => j.hh_job_number), delayMs: 3000 });
  console.log(`Done: ${res.processed} refreshed, ${res.failed} failed. Re-run without --run to see what is still held.`);
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => { console.error('Sweep failed:', err); await getPool().end().catch(() => undefined); process.exit(1); });
