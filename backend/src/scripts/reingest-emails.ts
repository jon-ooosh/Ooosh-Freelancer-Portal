/**
 * Reset + re-ingest Gmail emails (Auto-Chase cleanup).
 *
 * The early backfill over-attached whole threads on a bare job-number full-text
 * hit, so unrelated mail (Jon's personal eBay postage labels that happened to
 * contain a job number's digits) landed on job timelines. Rather than surgically
 * hunt each bad email, at this early stage the cleanest fix is a RESET: delete
 * the Gmail-ingested email interactions and re-run the now-tightened backfill
 * (which validates a thread genuinely belongs to a job before attaching it).
 *
 * SAFE + targeted: deletes ONLY interactions that came from Gmail ingestion
 * (`gmail_message_id IS NOT NULL` AND `type='email'`) — never staff-typed notes,
 * never the money/file "email"-type audit interactions (those have no
 * gmail_message_id). No emails/HH/Stripe calls fire. The live sync cursor is
 * untouched, so forward ingestion continues; --rebackfill repopulates history
 * cleanly through the tightened path.
 *
 * Usage (cd backend):
 *   npx tsx src/scripts/reingest-emails.ts                    # dry-run (counts only)
 *   npx tsx src/scripts/reingest-emails.ts --commit           # delete ingested emails
 *   npx tsx src/scripts/reingest-emails.ts --commit --rebackfill   # delete + re-ingest history
 */
import dotenv from 'dotenv';
dotenv.config();
import { query } from '../config/database';
import { isGmailConfigured } from '../config/gmail';
import { backfillOpenPipelineThreads } from '../services/gmail-backfill';

const commit = process.argv.includes('--commit');
const rebackfill = process.argv.includes('--rebackfill');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const counts = await query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT job_id)::int AS jobs
       FROM interactions
      WHERE type = 'email' AND gmail_message_id IS NOT NULL`,
  );
  const { n, jobs } = counts.rows[0] as { n: number; jobs: number };
  console.log(`Gmail-ingested email interactions: ${n} across ${jobs} job(s).`);

  // Show the busiest jobs so the effect is visible before committing.
  const sample = await query(
    `SELECT j.hh_job_number, j.job_name, COUNT(*)::int AS emails
       FROM interactions i JOIN jobs j ON j.id = i.job_id
      WHERE i.type = 'email' AND i.gmail_message_id IS NOT NULL
      GROUP BY j.hh_job_number, j.job_name
      ORDER BY emails DESC
      LIMIT 10`,
  );
  if (sample.rows.length) {
    console.log('\nTop jobs by ingested-email count:');
    for (const r of sample.rows) {
      console.log(`  #${r.hh_job_number ?? '—'}  ${r.emails.toString().padStart(3)}  ${r.job_name ?? ''}`);
    }
  }

  if (!commit) {
    console.log('\nDRY RUN — no changes. Pass --commit to delete, add --rebackfill to re-ingest history.');
    process.exit(0);
  }

  const del = await query(
    `DELETE FROM interactions WHERE type = 'email' AND gmail_message_id IS NOT NULL`,
  );
  console.log(`\nDeleted ${del.rowCount} Gmail-ingested email interaction(s).`);

  if (rebackfill) {
    if (!isGmailConfigured()) {
      console.log('Gmail not configured — skipping re-backfill. Run POST /api/auto-chase/backfill when ready.');
    } else {
      console.log('Re-ingesting history through the tightened backfill (scope=all)…');
      const summary = await backfillOpenPipelineThreads({ scope: 'all', limit: 1000 });
      console.log('Re-backfill summary:', JSON.stringify(summary, null, 2));
    }
  } else {
    console.log('Re-ingest history with: npx tsx src/scripts/reingest-emails.ts --commit --rebackfill');
    console.log('  (or the admin endpoint POST /api/auto-chase/backfill)');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
