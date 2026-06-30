import { query } from '../config/database';

/**
 * Set the post-hire `cost_resolve` close-out card to reflect whether every client
 * recharge on the job has been dealt with:
 *   - 'done' (green) → every recharge-flagged cost on the job is resolved
 *   - 'in_progress' (amber) → at least one is still 'pending'
 *
 * "Resolved" = recharge_status IN (recharged_hh, recharged_external, absorbed).
 * "Pending" = flagged for recharge (recharge_mode <> 'none') but not yet resolved.
 * Mirrors syncExcessRequirementStatus — resolution-authoritative (promotes AND
 * demotes), so a card staff marked Resolved while a recharge is still pending
 * gets pulled back to amber.
 *
 * 'blocked' and 'cancelled' are left untouched. Jobs with no recharge costs at
 * all are left untouched (the card isn't created for them).
 *
 * Pass a transaction client to run inside an existing transaction.
 */
export async function syncCostResolveRequirementStatus(
  jobId: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  const run = client
    ? (text: string, params: unknown[]) => client.query(text, params)
    : (text: string, params: unknown[]) => query(text, params);

  await run(
    `UPDATE job_requirements jr
     SET status = CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END,
         updated_at = NOW()
     FROM (
       SELECT
         NOT EXISTS (
           SELECT 1 FROM costs c
           WHERE c.job_id = $1
             AND c.recharge_mode <> 'none'
             AND COALESCE(c.recharge_status, 'pending') = 'pending'
         ) AS resolved,
         EXISTS (
           SELECT 1 FROM costs c2 WHERE c2.job_id = $1 AND c2.recharge_mode <> 'none'
         ) AS has_records
     ) rs
     WHERE jr.job_id = $1
       AND jr.requirement_type = 'cost_resolve'
       AND jr.phase = 'post_hire'
       AND jr.status IN ('not_started', 'in_progress', 'done')
       AND rs.has_records
       AND jr.status <> (CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END)`,
    [jobId],
  );
}
