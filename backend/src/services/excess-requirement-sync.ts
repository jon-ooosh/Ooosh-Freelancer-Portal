import { query } from '../config/database';

/**
 * Set the pre-hire excess requirement light to reflect REAL coverage across the
 * whole job:
 *   - 'done'  (green)  → EVERY excess record on the job is covered
 *   - 'in_progress' (amber) → at least one record still has money outstanding
 *
 * "Covered" per record = terminal-covered state, OR (amount_taken + amount_held)
 * meets the required amount. Terminal-covered = waived / rolled_over /
 * not_required / reimbursed / fully_claimed / partially_reimbursed. 'released'
 * is NOT covered (a pre-auth hold ended without capture — nothing kept), so a
 * released record with money still required drives the light to amber.
 *
 * This is coverage-AUTHORITATIVE (changed May 2026): it both promotes AND
 * demotes between not_started/in_progress/done so the card light and the
 * pre-hire progress bar always tie back to the money. Previously it only
 * promoted to 'done' when ANY one covered record existed — so a multi-driver /
 * single-van job (one chargeable driver + a `not_required` sibling, the top-N
 * algorithm) showed a false green even with the £1,200 still uncollected.
 *
 * 'blocked' (Problem) and 'cancelled' are deliberately left untouched. Jobs with
 * no excess records at all are left untouched (Van & Driver suspension, etc).
 *
 * Pass a transaction client to run inside an existing transaction.
 */
export async function syncExcessRequirementStatus(
  jobId: string,
  client?: { query: (text: string, params?: unknown[]) => Promise<unknown> },
): Promise<void> {
  const run = client
    ? (text: string, params: unknown[]) => client.query(text, params)
    : (text: string, params: unknown[]) => query(text, params);

  await run(
    `UPDATE job_requirements jr
     SET status = CASE WHEN cov.covered THEN 'done' ELSE 'in_progress' END,
         updated_at = NOW()
     FROM (
       SELECT
         NOT EXISTS (
           SELECT 1 FROM job_excess je
           WHERE je.job_id = $1
             AND je.excess_status NOT IN
               ('waived','rolled_over','not_required','reimbursed','fully_claimed','partially_reimbursed')
             AND COALESCE(je.excess_amount_taken, 0) + COALESCE(je.amount_held, 0)
                 < COALESCE(je.excess_amount_required, 0)
         ) AS covered,
         EXISTS (SELECT 1 FROM job_excess je2 WHERE je2.job_id = $1) AS has_records
     ) cov
     WHERE jr.job_id = $1
       AND jr.requirement_type = 'excess'
       AND jr.phase = 'pre_hire'
       AND jr.status IN ('not_started', 'in_progress', 'done')
       AND cov.has_records
       AND jr.status <> (CASE WHEN cov.covered THEN 'done' ELSE 'in_progress' END)`,
    [jobId],
  );

  // Post-hire close-out: the 'excess_resolve' card is RESOLUTION-authoritative
  // (changed May 2026). 'done' only when every record is in a terminal,
  // nothing-left-to-do state; otherwise 'in_progress' (amber). This is a
  // stronger bar than coverage above — a `taken` record is COVERED (collateral
  // held) but NOT RESOLVED (the money still has to be reimbursed or claimed now
  // the hire is over). Auto-advances when reimbursed / claimed / waived /
  // rolled_over, and amber-flags a card staff marked Resolved while money is
  // still in limbo. Returns-page progress bar (counts status='done') reflects
  // this for free.
  //
  // Resolved set: reimbursed / fully_claimed / waived / rolled_over /
  // not_required / released. A live `pre_auth` is deliberately NOT resolved
  // (a capture-or-release decision is still pending) — the card surfaces a blue
  // expiry countdown for that case rather than treating it as done.
  // 'blocked' (Dispute) and 'cancelled' are left untouched.
  //
  // held_on_account (migration 152): a deliberately-parked excess stays 'taken'
  // (so it's still counted in Total Held) but IS a resolution of this hire's
  // excess — the money is accounted for, earmarked for the client's future use.
  // Treat it as resolved so a completed job can close out cleanly instead of the
  // excess_resolve card nagging amber forever on money that's parked on purpose.
  await run(
    `UPDATE job_requirements jr
     SET status = CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END,
         updated_at = NOW()
     FROM (
       SELECT
         NOT EXISTS (
           SELECT 1 FROM job_excess je
           WHERE je.job_id = $1
             AND COALESCE(je.held_on_account, false) = false
             AND je.excess_status NOT IN
               ('reimbursed','fully_claimed','waived','rolled_over','not_required','released')
         ) AS resolved,
         EXISTS (SELECT 1 FROM job_excess je2 WHERE je2.job_id = $1) AS has_records
     ) rs
     WHERE jr.job_id = $1
       AND jr.requirement_type = 'excess_resolve'
       AND jr.phase = 'post_hire'
       AND jr.status IN ('not_started', 'in_progress', 'done')
       AND rs.has_records
       AND jr.status <> (CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END)`,
    [jobId],
  );
}
