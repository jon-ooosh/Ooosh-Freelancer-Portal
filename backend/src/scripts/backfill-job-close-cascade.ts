/**
 * Backfill the job close cascade over jobs that died before the fix.
 *
 * `services/job-close-cascade.ts` (Sep 2026) closed the two paths that used to
 * mark a job lost/cancelled without cleaning up its transport — the 09:00
 * stale-enquiry auto-loser and the HireHop webhook. That fix is
 * forward-looking: jobs already closed through those paths still carry live
 * quotes, live `quote_assignments` and possibly stray
 * `vehicle_hire_assignments`.
 *
 * This script runs the REAL `cascadeJobClose` over them — not a hand-written
 * SQL equivalent — so the backfill and the live path can't drift, and so the
 * fleet `hire_status` recompute (`syncFleetHireStatus`, application code that
 * SQL can't reach) actually happens. Without that recompute a van whose dead
 * hire is swept keeps its stale cached status and stays unavailable for prep.
 *
 * Idempotent: every UPDATE inside the cascade skips already-cancelled rows, so
 * re-running is a no-op. Soft-cancel only, per CLAUDE.md.
 *
 * ── Email safety ────────────────────────────────────────────────────────
 * The cascade emails crew only while a job still has work left in it (the
 * later of `job_date` / `job_end` being today or later). Every job the
 * auto-loser touched is finished by definition, so a normal backfill mails
 * nobody. But four of the affected jobs were closed MANUALLY back in
 * Mar/Apr 2026, and a manual close carries no such guarantee — so this
 * refuses to commit if any target job is still live, rather than surprising a
 * freelancer with a cancellation notice for a job they were told about months
 * ago. Pass --allow-emails to go ahead deliberately.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-job-close-cascade.ts                 # dry-run
 *   npx tsx src/scripts/backfill-job-close-cascade.ts --commit
 *   npx tsx src/scripts/backfill-job-close-cascade.ts --job=16485     # one job
 *   npx tsx src/scripts/backfill-job-close-cascade.ts --commit --allow-emails
 */
// `config/database` loads dotenv itself as it initialises the pool, and ES
// imports hoist — so there is deliberately no dotenv call here. A second one
// would run after the pool already existed and change nothing.
import pool, { query } from '../config/database';
import { cascadeJobClose } from '../services/job-close-cascade';

const commit = process.argv.includes('--commit');
const allowEmails = process.argv.includes('--allow-emails');
const jobArg = process.argv.find((a) => a.startsWith('--job='))?.split('=')[1];

interface TargetRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: 'lost' | 'cancelled';
  pipeline_status_changed_at: string | null;
  job_date: string | null;
  job_end: string | null;
  live_quotes: string;
  live_assignments: string;
  live_vha: string;
}

function isStillLive(row: TargetRow): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [row.job_date, row.job_end]
    .filter(Boolean)
    .map((d) => new Date(d as string))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (dates.length === 0) return false;
  return new Date(Math.max(...dates.map((d) => d.getTime()))) >= today;
}

function fmt(d: string | null): string {
  return d ? new Date(d).toISOString().split('T')[0] : '—';
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Same predicate as the diagnostic query, widened to also catch jobs whose
  // quotes are clean but whose assignments or vehicle rows are not — a job
  // half-cleaned by hand still has work left to do on it.
  const targets = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.pipeline_status,
            j.pipeline_status_changed_at, j.job_date, j.job_end,
            COUNT(DISTINCT q.id) FILTER (
              WHERE q.status NOT IN ('cancelled', 'completed')
            ) AS live_quotes,
            COUNT(DISTINCT qa.id) FILTER (
              WHERE qa.status NOT IN ('cancelled', 'declined')
            ) AS live_assignments,
            (SELECT COUNT(*) FROM vehicle_hire_assignments vha
              WHERE (vha.job_id = j.id
                     OR (vha.job_id IS NULL AND vha.hirehop_job_id = j.hh_job_number))
                AND vha.status NOT IN ('cancelled', 'returned', 'swapped')
            ) AS live_vha
       FROM jobs j
       LEFT JOIN quotes q ON q.job_id = j.id AND q.is_deleted = false
       LEFT JOIN quote_assignments qa ON qa.quote_id = q.id
      WHERE j.pipeline_status IN ('lost', 'cancelled')
        AND j.is_deleted = false
        ${jobArg ? 'AND j.hh_job_number = $1::integer' : ''}
      GROUP BY j.id, j.hh_job_number, j.job_name, j.pipeline_status,
               j.pipeline_status_changed_at, j.job_date, j.job_end
     HAVING COUNT(DISTINCT q.id) FILTER (
              WHERE q.status NOT IN ('cancelled', 'completed')
            ) > 0
         OR COUNT(DISTINCT qa.id) FILTER (
              WHERE qa.status NOT IN ('cancelled', 'declined')
            ) > 0
         OR (SELECT COUNT(*) FROM vehicle_hire_assignments vha
              WHERE (vha.job_id = j.id
                     OR (vha.job_id IS NULL AND vha.hirehop_job_id = j.hh_job_number))
                AND vha.status NOT IN ('cancelled', 'returned', 'swapped')
            ) > 0
      ORDER BY j.pipeline_status_changed_at DESC NULLS LAST`,
    jobArg ? [jobArg] : []
  );

  const rows = targets.rows as TargetRow[];

  console.log(`\n${commit ? 'APPLYING' : 'DRY RUN'} — job close cascade backfill`);
  console.log(`${rows.length} job(s) closed with transport still live\n`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const live: TargetRow[] = [];
  for (const r of rows) {
    const stillLive = isStillLive(r);
    if (stillLive) live.push(r);
    console.log(
      `  #${String(r.hh_job_number ?? '—').padEnd(6)} ${r.pipeline_status.padEnd(9)}` +
        ` closed ${fmt(r.pipeline_status_changed_at)}` +
        `  dates ${fmt(r.job_date)}→${fmt(r.job_end)}` +
        `  quotes=${r.live_quotes} assignments=${r.live_assignments} vans=${r.live_vha}` +
        (stillLive ? '   ⚠ STILL LIVE — would email crew' : '')
    );
    if (r.job_name) console.log(`          ${r.job_name}`);
  }

  if (live.length > 0) {
    console.log(
      `\n⚠  ${live.length} job(s) above have not finished yet, so the cascade WOULD email`
    );
    console.log('   their crew a cancellation notice. Check that is wanted before committing.');
    if (commit && !allowEmails) {
      console.log('\n   Refusing to commit. Re-run with --allow-emails once you have decided,');
      console.log('   or narrow to the finished jobs with --job=<number>.');
      process.exit(1);
    }
  }

  if (!commit) {
    console.log('\nDry run — nothing changed. Re-run with --commit to apply.');
    return;
  }

  console.log('');
  let totals = { quotes: 0, assignments: 0, vans: 0, emails: 0 };
  for (const r of rows) {
    const res = await cascadeJobClose({
      jobId: r.id,
      reason: r.pipeline_status,
      // No actor: this is a backfill, not a person's decision. Matches how the
      // cron and webhook paths record themselves.
      actorUserId: null,
    });
    totals = {
      quotes: totals.quotes + res.quotesCancelled,
      assignments: totals.assignments + res.assignmentsCancelled,
      vans: totals.vans + res.vehicleAssignmentsCancelled,
      emails: totals.emails + res.crewEmailed,
    };
    console.log(
      `  #${String(r.hh_job_number ?? '—').padEnd(6)} → ` +
        `${res.quotesCancelled} quote(s), ${res.assignmentsCancelled} assignment(s), ` +
        `${res.vehicleAssignmentsCancelled} van row(s), ${res.crewEmailed} email(s)`
    );
  }

  console.log(
    `\nDone. ${totals.quotes} quote(s), ${totals.assignments} assignment(s), ` +
      `${totals.vans} vehicle row(s) cancelled. ${totals.emails} crew email(s) sent.`
  );
  console.log('Re-run the diagnostic query to confirm it comes back empty.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
