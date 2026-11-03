/**
 * Seed the HireHop invoice-number list (hh_invoice_index, migration 326) that the
 * Wise matcher looks "OT-INV-12345" up in. Run ONCE after deploying it — from then
 * on the Money tab, the nightly money refresh and HireHop's invoice webhooks keep it
 * current. Safe to re-run: each job's entries are simply replaced.
 *
 * Scope: every HireHop-linked job that isn't lost or deleted and whose dates are
 * within the last 180 days or ahead (any status — enquiries and cancelled jobs can
 * carry invoices too). One HireHop billing read per job, with an extra pause on top
 * of the broker's own pacing so the live app and the payment portal keep headroom
 * under HireHop's 60 a minute. Best run in the evening.
 *
 * Usage (on the server, cd backend):
 *   npx tsx src/scripts/backfill-invoice-index.ts               # dry run: how many jobs, how long
 *   npx tsx src/scripts/backfill-invoice-index.ts --commit
 *   npx tsx src/scripts/backfill-invoice-index.ts --commit --days=365 --delay=2000
 */
import dotenv from 'dotenv';

dotenv.config();

import { query } from '../config/database';
import { refreshInvoiceIndexForHhJob } from '../services/hh-invoice-index';

function argNum(name: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const n = a ? parseInt(a.split('=')[1], 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main() {
  const commit = process.argv.includes('--commit');
  const days = argNum('days', 180);
  const delayMs = argNum('delay', 1500);

  const jobs = await query(
    `SELECT hh_job_number
       FROM jobs
      WHERE hh_job_number IS NOT NULL
        AND COALESCE(is_deleted, false) = false
        AND COALESCE(pipeline_status, '') <> 'lost'
        AND (job_end IS NULL OR job_end >= NOW() - ($1 || ' days')::interval)
      ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(job_date, NOW()) - NOW())))`,
    [String(days)],
  );
  const list = jobs.rows.map((r: { hh_job_number: number }) => r.hh_job_number);
  const minutes = Math.ceil((list.length * (1800 + delayMs)) / 60000);
  console.log(`${list.length} jobs to read (dates within ${days} days or ahead) — about ${minutes} minutes.`);
  if (!commit) {
    console.log('Dry run — nothing read. Add --commit to fill the list.');
    process.exit(0);
  }

  let done = 0;
  let invoices = 0;
  let failed = 0;
  for (const hh of list) {
    const n = await refreshInvoiceIndexForHhJob(hh);
    if (n === null) failed++;
    else invoices += n;
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${list.length} jobs, ${invoices} invoices so far, ${failed} failed`);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`Done — ${done} jobs read, ${invoices} numbered invoices listed, ${failed} failed (re-run to retry them).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
