/**
 * Backfill `jobs.job_value` from HireHop billing accrued.
 *
 * One-shot repair for the Jul 2026 job_value clobbering bug: the 30-min HH
 * job sync (and the inbound webhook) used to overwrite job_value with
 * search_list.php's MONEY field, which is empty/0 for most jobs — zeroing
 * out values across the pipeline, client-history sidebars and hire-history
 * stats. Run this once after deploying the fix (which stops those writes)
 * to repopulate every affected job from the authoritative source: the
 * kind=0 (job total) row's `accrued` figure in billing_list.php.
 *
 * Scope: ALL HH-linked jobs with job_value NULL or 0, including lost /
 * cancelled / completed (their values feed hire-history stats). Jobs whose
 * billing genuinely accrues £0 (nothing priced in HH) are reported but left
 * untouched.
 *
 * Rate limiting: direct HH calls with a 1.5s delay (~40/min), leaving
 * headroom under HireHop's 60/min limit for the live app running alongside.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-job-values.ts                    # dry-run
 *   npx tsx src/scripts/backfill-job-values.ts --commit           # apply
 *   npx tsx src/scripts/backfill-job-values.ts --limit=100        # cap jobs checked
 *   npx tsx src/scripts/backfill-job-values.ts --active-only      # skip lost/cancelled/completed
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');
const activeOnly = process.argv.includes('--active-only');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

const DELAY_MS = 1500; // ~40 req/min, HH allows 60

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the accrued (ex-VAT) hire value from HH billing_list. */
async function fetchAccrued(
  domain: string,
  token: string,
  hhJobNumber: number,
): Promise<number | null> {
  const url = new URL(`https://${domain}/php_functions/billing_list.php`);
  url.searchParams.set('token', token);
  url.searchParams.set('main_id', String(hhJobNumber));
  url.searchParams.set('type', '1');

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.trim().startsWith('<')) {
    throw new Error('HTML response (auth error?)');
  }
  const data = JSON.parse(text) as Record<string, any>;
  if (data.error) {
    throw new Error(`HH error ${data.error}`);
  }
  if (!data.rows || !Array.isArray(data.rows)) return null;

  for (const row of data.rows) {
    if (parseInt(row.kind ?? '0') === 0) {
      const accrued = parseFloat(row.accrued || row.data?.accrued || '0');
      return Number.isFinite(accrued) ? accrued : null;
    }
  }
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const token = process.env.HIREHOP_API_TOKEN;
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
  if (!token) {
    console.error('HIREHOP_API_TOKEN not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`Mode:  ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}`);
    console.log(`Scope: ${activeOnly ? 'active statuses only (skip 9/10/11)' : 'all HH-linked jobs'}${limit > 0 ? `, limit ${limit}` : ''}\n`);

    const statusFilter = activeOnly ? 'AND status NOT IN (9, 10, 11)' : '';
    const jobs = await pool.query(
      `SELECT id, hh_job_number, job_name, status_name, pipeline_status, job_value
       FROM jobs
       WHERE hh_job_number IS NOT NULL
         AND (job_value IS NULL OR job_value = 0)
         AND is_deleted = false
         ${statusFilter}
       ORDER BY job_date DESC NULLS LAST
       ${limit > 0 ? `LIMIT ${limit}` : ''}`,
    );

    console.log(`Found ${jobs.rows.length} HH-linked job(s) with NULL/£0 job_value.`);
    const estMins = Math.ceil((jobs.rows.length * DELAY_MS) / 60000);
    if (jobs.rows.length > 0) {
      console.log(`Estimated runtime: ~${estMins} minute(s) at ${DELAY_MS}ms per HH call.\n`);
    }

    let updated = 0;
    let stillZero = 0;
    let errors = 0;
    let processed = 0;

    for (const job of jobs.rows) {
      processed++;
      const label = `#${job.hh_job_number} ${(job.job_name || '').slice(0, 45)}`;
      try {
        const accrued = await fetchAccrued(domain, token, job.hh_job_number);
        if (accrued != null && accrued > 0) {
          if (commit) {
            await pool.query(`UPDATE jobs SET job_value = $1 WHERE id = $2`, [accrued, job.id]);
          }
          updated++;
          console.log(`  [${processed}/${jobs.rows.length}] ${label} → £${accrued.toFixed(2)}${commit ? '' : ' (dry-run)'}`);
        } else {
          stillZero++;
          // Nothing priced/accrued in HH — legitimate for unpriced enquiries
        }
      } catch (err) {
        errors++;
        console.warn(`  [${processed}/${jobs.rows.length}] ${label} — SKIPPED: ${err instanceof Error ? err.message : err}`);
      }

      if (processed % 50 === 0) {
        console.log(`  … ${processed}/${jobs.rows.length} checked (${updated} with values so far)`);
      }
      if (processed < jobs.rows.length) {
        await sleep(DELAY_MS);
      }
    }

    console.log(`\nChecked:            ${processed}`);
    console.log(`Values found:       ${updated}${commit ? ' (written)' : ' (would be written)'}`);
    console.log(`Genuinely £0 in HH: ${stillZero} (left untouched)`);
    console.log(`Errors/skipped:     ${errors}`);

    if (!commit && updated > 0) {
      console.log(`\nDry run — re-run with --commit to apply ${updated} update(s).`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
