/**
 * Find past quote PDFs for jobs OP never searched — mostly lost and cancelled ones —
 * so the business figures can show "time to quote" against booked AND lost
 * (docs/BUSINESS-FIGURES-SPEC.md, step 2).
 *
 * OP only looks for a job's quotes when someone opens its timeline, or for open and
 * confirmed jobs in the admin sweep (quote-versions.ts). This walks every job with a
 * HireHop number made since --since that has never been searched, and runs the same
 * harvest on it (quote-harvest.ts harvestQuotesForJob — Gmail search, PDF to R2,
 * job_quote_versions). Read-only on Gmail. Safe to re-run: searched jobs are skipped,
 * and a PDF already stored is never stored twice.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/harvest-quote-history.ts                         # how many jobs, nothing done
 *   npx tsx src/scripts/harvest-quote-history.ts --run                   # search them all
 *   npx tsx src/scripts/harvest-quote-history.ts --run --since 2026-04-01 --limit 500
 *
 * Paced at one job a second so live Gmail ingestion keeps its share of the quota;
 * a few thousand jobs is an hour or so. Stop it any time (Ctrl+C) and run again.
 */
import dotenv from 'dotenv';
dotenv.config();
import { query, getPool } from '../config/database';
import { harvestQuotesForJob } from '../services/quote-harvest';
import { isGmailConfigured } from '../config/gmail';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const RUN = process.argv.includes('--run');
const SINCE = arg('since') || '2026-04-01';
const LIMIT = Math.max(1, Math.min(Number(arg('limit')) || 10000, 20000));
const PAUSE_MS = 1000;

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) throw new Error('--since must be YYYY-MM-DD');
  if (RUN && !isGmailConfigured()) throw new Error('Gmail is not configured on this server.');

  const jobs = await query(
    `SELECT j.id, j.hh_job_number, j.pipeline_status
       FROM jobs j
       LEFT JOIN job_quote_harvest_state s ON s.job_id = j.id
      WHERE j.is_deleted = false
        AND j.hh_job_number IS NOT NULL
        AND (s.job_id IS NULL OR s.last_error IS NOT NULL)   -- never searched, or the last search failed
        AND LEAST(j.created_at, COALESCE(j.created_date, j.created_at)) >= $1::date
      ORDER BY j.created_at
      LIMIT $2`,
    [SINCE, LIMIT],
  );
  const byStatus = new Map<string, number>();
  for (const j of jobs.rows) byStatus.set(j.pipeline_status || 'none', (byStatus.get(j.pipeline_status || 'none') || 0) + 1);
  console.log(`${jobs.rows.length} job(s) made since ${SINCE} have never been searched for quotes (or the last search failed):`);
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);
  if (!RUN) {
    console.log('\nNothing searched — add --run to search them.');
    return;
  }

  let done = 0, withQuotes = 0, stored = 0, failed = 0;
  for (const j of jobs.rows) {
    const res = await harvestQuotesForJob(j.id);
    done++;
    if (res.error) failed++;
    if (res.versionsTotal > 0) withQuotes++;
    stored += res.stored;
    if (done % 25 === 0 || done === jobs.rows.length) {
      console.log(`  ${done}/${jobs.rows.length} searched · ${withQuotes} with quotes · ${stored} PDFs stored · ${failed} errors`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  console.log(`\nDone. ${withQuotes} of ${done} jobs had quotes; ${stored} PDFs stored.${failed ? ` ${failed} errors — run again later to retry those.` : ''}`);
}

main()
  .then(async () => { await getPool().end(); process.exit(0); })
  .catch(async (err) => { console.error('Harvest failed:', err); await getPool().end().catch(() => undefined); process.exit(1); });
