/**
 * Reconcile the top-N excess ranking across existing jobs.
 *
 * WHY: until Sep 2026 both write paths ranked drivers by ARRIVAL, not amount
 * (see services/excess-topn.ts for the full account). A hire where a clean
 * £1,200 driver submitted before a higher-risk one collected the lower figure
 * and said nothing. That is now corrected as drivers are written, but every
 * job created before the fix still carries whatever ranking arrival happened to
 * produce. This sweeps them.
 *
 * SAFE: goes through the same money-guarded reconcile the live paths use, so a
 * record holding cash, a HireHop deposit, a Stripe PI or a rollover chain is
 * never demoted or re-priced. It touches NO HireHop, NO Stripe, NO email — it
 * only corrects which OP record carries the charge, and for how much.
 *
 * Jobs where the correct ranking CANNOT be applied because money is already on
 * the wrong record are reported as UNDER-COLLECTED for a human to decide (top
 * up, or accept). Those are never auto-changed.
 *
 * SCOPE: live hires only. A finished hire (returned / completed / cancelled /
 * lost) is never reshuffled — its excess is history, and moving the charge
 * between drivers on a settled job achieves nothing but retrospectively
 * inflating "required". The reconcile itself enforces this; the scan query
 * below matches it so the job count reported is the job count considered.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/reconcile-excess-topn.ts                 # dry run
 *   npx tsx src/scripts/reconcile-excess-topn.ts --commit
 *   npx tsx src/scripts/reconcile-excess-topn.ts --job=16605     # one HH job
 *   npx tsx src/scripts/reconcile-excess-topn.ts --upcoming      # future hires only
 */
import pool, { query } from '../config/database';
import { reconcileJobExcessTopN } from '../services/excess-topn';

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const UPCOMING = argv.includes('--upcoming');
const jobArg = argv.find((a) => a.startsWith('--job='));
const ONE_JOB = jobArg ? Number(jobArg.split('=')[1]) : null;

async function main() {
  console.log(`\n=== Top-N excess reconcile — ${COMMIT ? 'COMMIT' : 'DRY RUN'} ===\n`);

  const jobs = await query(
    `SELECT DISTINCT j.id, j.hh_job_number, j.job_name, j.pipeline_status,
            COALESCE(j.job_date, j.out_date) AS starts
       FROM jobs j
       JOIN job_excess je ON je.job_id = j.id AND je.assignment_id IS NOT NULL
      WHERE COALESCE(j.is_internal, false) = false
        AND j.pipeline_status NOT IN
            ('returned_incomplete', 'returned', 'completed', 'cancelled', 'lost')
        ${ONE_JOB ? 'AND j.hh_job_number = $1' : ''}
        ${UPCOMING ? 'AND COALESCE(j.job_date, j.out_date) >= CURRENT_DATE' : ''}
      ORDER BY starts DESC NULLS LAST`,
    ONE_JOB ? [ONE_JOB] : [],
  );

  console.log(`Scanning ${jobs.rows.length} live job(s) with driver-linked excess records.`);
  console.log(`(Finished hires are excluded — their excess is settled history.)\n`);

  let changed = 0;
  let underCollected = 0;
  let shortfallTotal = 0;

  for (const j of jobs.rows) {
    let result;
    try {
      result = await reconcileJobExcessTopN(query, j.id, { dryRun: !COMMIT });
    } catch (err) {
      console.error(`  #${j.hh_job_number} ERROR:`, (err as Error).message);
      continue;
    }

    const ref = `#${j.hh_job_number ?? '—'} ${String(j.job_name || '').slice(0, 44)}`;

    if (result.changed) {
      changed++;
      console.log(`${COMMIT ? 'FIXED' : 'WOULD FIX'}  ${ref}`);
      console.log(`           ${result.summary}`);
    }

    if (result.blocked.length > 0) {
      underCollected++;
      const shortfall = Math.max(result.correctTotal - result.chargeableTotal, 0);
      shortfallTotal += shortfall;
      console.log(`UNDER-COLLECTED  ${ref}`);
      console.log(`           holds £${result.chargeableTotal}, should be £${result.correctTotal} (short £${shortfall})`);
      for (const b of result.blocked) {
        console.log(`           ${b.driverName || 'driver'} is liable for £${b.shouldBe} but money sits on another record`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${COMMIT ? 'Corrected' : 'Would correct'}: ${changed} job(s)`);
  console.log(`Under-collected (needs a human): ${underCollected} job(s), £${shortfallTotal} total shortfall`);
  if (!COMMIT && changed > 0) console.log(`\nRe-run with --commit to apply.`);
  console.log();
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
