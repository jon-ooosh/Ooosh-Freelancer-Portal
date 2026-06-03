/**
 * job-financials-backfill.ts — populates the `job_financials` cache for jobs
 * whose Money tab hasn't been opened recently, so the /money/overview
 * dashboard reflects history rather than only jobs staff happen to have viewed.
 *
 * ZERO-DRIFT BY DESIGN: rather than re-implement the (intricate) billing
 * classification + VAT logic, this drives the existing
 * `GET /api/money/:hhJobNumber/summary` endpoint over local HTTP. That handler
 * already write-throughs the computed figures to `job_financials` as a side
 * effect — so the dashboard cache is filled by the exact same code path staff
 * trigger by opening the tab. One source of truth for the figures.
 *
 * Pacing: sequential with a delay between jobs. The HireHop broker rate-limits
 * globally anyway, but the delay keeps the nightly run from starving any
 * real-time user requests. Intended to run at ~03:00 when little else is happening.
 */
import jwt from 'jsonwebtoken';
import { query } from '../config/database';

interface BackfillOpts {
  /** Max jobs to process in one run. Default 300. */
  limit?: number;
  /** Delay between jobs in ms. Default 4000. */
  delayMs?: number;
  /** Re-sync a job whose cache is older than this many days. Default 7. */
  staleAfterDays?: number;
}

interface BackfillResult { processed: number; failed: number; candidates: number }

export async function backfillJobFinancials(opts: BackfillOpts = {}): Promise<BackfillResult> {
  const limit = opts.limit ?? 300;
  const delayMs = opts.delayMs ?? 4000;
  const staleAfterDays = opts.staleAfterDays ?? 7;

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('[fin-backfill] JWT_SECRET not set — skipping');
    return { processed: 0, failed: 0, candidates: 0 };
  }
  const port = process.env.PORT || 3001;
  const base = `http://127.0.0.1:${port}`;

  // Authenticate as a real active admin/manager (the /summary route needs a
  // valid user). The token is short-lived and never leaves the box.
  const userRes = await query(
    `SELECT id, email, role FROM users
     WHERE is_active = true AND role IN ('admin','manager')
     ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END
     LIMIT 1`
  );
  if (userRes.rows.length === 0) {
    console.warn('[fin-backfill] no active admin/manager user — skipping');
    return { processed: 0, failed: 0, candidates: 0 };
  }
  const u = userRes.rows[0] as { id: string; email: string; role: string };
  const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, secret, { expiresIn: '2h' });

  // Candidates: real jobs (HH-linked, booked or beyond — enquiries have no
  // meaningful billing), not dead, whose cache is missing or stale. Never-synced
  // first, then stalest; within those, most recent jobs first so the
  // operationally-relevant history fills before ancient hires.
  const cand = await query(
    `SELECT j.hh_job_number
     FROM jobs j
     LEFT JOIN job_financials jf ON jf.job_id = j.id
     WHERE j.hh_job_number IS NOT NULL
       AND COALESCE(j.pipeline_status, '') NOT IN ('lost', 'cancelled')
       AND (j.status >= 2 OR j.pipeline_status IN
            ('confirmed','prepping','prepped','dispatched','returned_incomplete','returned','completed'))
       AND (jf.job_id IS NULL OR jf.last_synced_at < NOW() - ($1 || ' days')::interval)
     ORDER BY jf.last_synced_at ASC NULLS FIRST, j.job_date DESC NULLS LAST
     LIMIT $2`,
    [String(staleAfterDays), limit]
  );

  let processed = 0;
  let failed = 0;
  for (const row of cand.rows as Array<{ hh_job_number: number }>) {
    const hh = row.hh_job_number;
    try {
      const resp = await fetch(`${base}/api/money/${hh}/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        processed++;
      } else {
        failed++;
        console.warn(`[fin-backfill] job ${hh} → HTTP ${resp.status}`);
      }
    } catch (e) {
      failed++;
      console.warn(`[fin-backfill] job ${hh} failed:`, e instanceof Error ? e.message : e);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`[fin-backfill] done — ${processed} synced, ${failed} failed, ${cand.rows.length} candidates`);
  return { processed, failed, candidates: cand.rows.length };
}
