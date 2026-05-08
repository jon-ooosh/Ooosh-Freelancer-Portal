/**
 * Send hire form emails for jobs that fell through the auto-emailer's gap.
 *
 * Background: pre-May 2026 the auto-emailer had:
 *   - An exact `= 10` day match (no recovery if a single day was missed)
 *   - A narrow contact lookup (only client_id org + people, not job_organisations)
 *   - No on-confirmation hook on HH-webhook-driven status changes
 *   - No backstop for jobs that hit the 4-5 day chase window without an
 *     initial having been sent (chase WHERE clause required initial-sent
 *     marker, so missed-initial → no chase either)
 *
 * Result: ~14 self-drive jobs in the next 14 days had hire_forms requirement
 * status=not_started with no "Hire form email sent" note even though they
 * should have been emailed.
 *
 * This script runs the SAME `sendHireFormEmailForJob` path the auto-emailer
 * uses (which now uses the broad resolver), targeted at any matching job.
 * Idempotent — uses the standard `notes NOT LIKE 'Hire form email sent%'`
 * guard internally.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/send-missing-hire-form-emails.ts            # dry-run
 *   npx tsx src/scripts/send-missing-hire-form-emails.ts --commit   # actually send
 */

import { query } from '../config/database';
import { sendHireFormEmailForJob } from '../services/hire-form-auto-email';
import dotenv from 'dotenv';

dotenv.config();

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log(`\n=== Hire form remediation ===`);
  console.log(`Mode: ${COMMIT ? 'COMMIT — will send emails' : 'DRY-RUN — no emails will be sent'}\n`);

  // Same query as the spread diagnostic that found the affected jobs.
  // Constrained to confirmed/provisional/prepping/prepped jobs starting in
  // the next 14 days where hire_forms is still not_started and the notes
  // don't already record an initial send.
  const candidates = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.job_date, j.company_name, j.client_name, j.client_id,
            jr.id AS req_id, jr.notes AS req_notes,
            (j.job_date::date - CURRENT_DATE) AS days_to_go
     FROM jobs j
     JOIN job_requirements jr
       ON jr.job_id = j.id
      AND jr.requirement_type = 'hire_forms'
     WHERE j.is_deleted = false
       AND j.is_van_and_driver = false
       AND j.hh_job_number IS NOT NULL
       AND j.job_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
       AND j.pipeline_status IN ('confirmed','provisional','prepping','prepped')
       AND jr.status = 'not_started'
       AND (jr.notes IS NULL OR jr.notes NOT LIKE '%Hire form email sent%')
     ORDER BY j.job_date ASC`
  );

  if (candidates.rows.length === 0) {
    console.log('No affected jobs found. Nothing to do.\n');
    return;
  }

  console.log(`Found ${candidates.rows.length} affected job(s):\n`);
  for (const job of candidates.rows) {
    console.log(`  • #${job.hh_job_number} (${job.client_name}) — hire ${job.job_date.toISOString().slice(0, 10)} (${job.days_to_go} days to go)`);
  }
  console.log('');

  if (!COMMIT) {
    console.log('Dry-run complete. Re-run with --commit to actually send the emails.\n');
    return;
  }

  let totalSent = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const job of candidates.rows) {
    try {
      // Inside chase window (4-5 days)? Treat as missed-initial backstop so
      // it correctly fires the silent-skip alert.
      const isLateBackstop = job.days_to_go >= 4 && job.days_to_go <= 5;
      const sent = await sendHireFormEmailForJob(job, false, { isLateBackstop });
      if (sent > 0) {
        console.log(`  ✓ #${job.hh_job_number}: sent ${sent} email(s)${isLateBackstop ? ' (late backstop)' : ''}`);
        totalSent += sent;
      } else {
        console.log(`  ⚠ #${job.hh_job_number}: 0 emails sent (silent-skip alert fired to info@ if no contacts resolved)`);
        totalSkipped++;
      }
    } catch (err) {
      console.error(`  ✗ #${job.hh_job_number}: error — ${err}`);
      totalFailed++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Sent: ${totalSent}`);
  console.log(`Skipped (no contacts / fallback fired): ${totalSkipped}`);
  console.log(`Failed: ${totalFailed}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  });
