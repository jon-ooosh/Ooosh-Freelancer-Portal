/**
 * Manual driver for the job_financials backfill (the same routine the 03:00
 * scheduler runs). Useful for seeding the /money/overview dashboard on first
 * deploy without waiting for nightly runs.
 *
 * IMPORTANT: the backend server must be RUNNING — this drives the live
 * /api/money/:hh/summary endpoint over localhost (that's what populates the
 * cache, zero-drift). Run it on the box alongside the systemd service.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/backfill-job-financials.ts                       # 300 jobs, 4s apart
 *   npx tsx src/scripts/backfill-job-financials.ts --limit=50 --delay=2000
 *   npx tsx src/scripts/backfill-job-financials.ts --stale=14            # only re-sync caches >14d old
 *
 * Re-run across several invocations/nights to fill all history — never-synced
 * and stalest jobs are picked first each run, so it converges.
 */
import dotenv from 'dotenv';
import { backfillJobFinancials } from '../services/job-financials-backfill';

dotenv.config();

function argNum(name: string): number | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

backfillJobFinancials({
  limit: argNum('limit'),
  delayMs: argNum('delay'),
  staleAfterDays: argNum('stale'),
})
  .then((r) => {
    console.log(`Backfill complete: ${r.processed} synced, ${r.failed} failed, ${r.candidates} candidates.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
