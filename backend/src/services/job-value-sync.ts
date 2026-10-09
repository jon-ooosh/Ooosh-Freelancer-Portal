/**
 * Job Value Sync — keeps the cached `jobs.job_value` column populated.
 *
 * `jobs.job_value` is a CACHED display value (ex-VAT hire value) read by the
 * pipeline/Kanban, client-history + band-history sidebars, hire-history
 * stats on Org/Person detail, dashboard figures, fill-a-gap scoring and the
 * AI chase drafts. The authoritative source is HireHop billing
 * (`billing_list.php` kind=0 row's `accrued` field).
 *
 * Writers of job_value:
 *   - Money tab /summary side-effect (instant self-heal when a job is viewed)
 *   - This gap-filler (hourly scheduler task + POST /api/money/sync-values)
 *   - Manual inline edit on Job Detail / New Enquiry form
 *
 * The HH job sync + inbound webhook deliberately do NOT write job_value —
 * HireHop's search_list.php MONEY field is empty/0 for most jobs and used to
 * clobber the cached value back to £0 every 30 minutes (fixed Jul 2026).
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';

/**
 * Fetch the accrued (ex-VAT) hire value for a HireHop job from billing_list.
 * Returns null when billing is unreachable or has no kind=0 (job total) row.
 */
export async function fetchAccruedJobValue(hhJobNumber: number): Promise<number | null> {
  const billingRes = await hhBroker.get('/php_functions/billing_list.php',
    { main_id: hhJobNumber, type: 1 },
    { priority: 'low', cacheTTL: 300 }
  );

  if (!billingRes.success || !billingRes.data) return null;
  const bl = billingRes.data as Record<string, any>;
  if (!bl.rows || !Array.isArray(bl.rows)) return null;

  for (const row of bl.rows) {
    if (parseInt(row.kind ?? '0') === 0) {
      const accrued = parseFloat(row.accrued || row.data?.accrued || '0');
      return Number.isFinite(accrued) ? accrued : null;
    }
  }
  return null;
}

/**
 * Populate job_value from HH billing accrued for HH-linked jobs still
 * showing NULL/£0. Active jobs only (statuses 9/10/11 are out of the sync
 * set, so their last-written value stands) — most recently touched first.
 *
 * Jobs whose billing genuinely accrues £0 (nothing priced in HH yet) are
 * left untouched and re-checked on later passes; the calls are low-priority
 * broker reads with a 5-min cache, so the recheck cost is negligible.
 */
export async function syncMissingJobValues(limit = 20): Promise<{ checked: number; updated: number }> {
  const jobsResult = await query(
    `SELECT id, hh_job_number FROM jobs
     WHERE hh_job_number IS NOT NULL
       AND (job_value IS NULL OR job_value = 0)
       AND status NOT IN (9, 10, 11)
       AND is_deleted = false
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );

  let updated = 0;
  // Sequential — the broker rate-limits, but no point flooding its queue
  for (const job of jobsResult.rows) {
    try {
      const accrued = await fetchAccruedJobValue(job.hh_job_number);
      if (accrued != null && accrued > 0) {
        await query(`UPDATE jobs SET job_value = $1 WHERE id = $2`, [accrued, job.id]);
        updated++;
      }
    } catch { /* skip individual failures */ }
  }

  return { checked: jobsResult.rows.length, updated };
}
