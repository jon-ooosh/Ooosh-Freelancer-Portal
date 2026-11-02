import { query } from '../config/database';

/**
 * Set the pre-hire excess requirement light to reflect REAL coverage across the
 * whole job:
 *   - 'done'  (green)  → EVERY excess record on the job is covered
 *   - 'in_progress' (amber) → some money has moved, but not enough yet
 *   - 'not_started' (grey) → nothing has happened to this excess at all
 *
 * The not_started arm was added Sep 2026. Before it, this was BINARY — covered
 * or 'in_progress' — so a job with £1,200 required and nothing collected, on
 * which nobody had lifted a finger, reported "In progress" on the card, the
 * dashboard pip AND the pre-hire staff briefing email. It should say To do.
 * `not_started` maps to `todo` in job-progress-strip.ts, so the one status fix
 * corrects every surface at once.
 *
 * "Started" deliberately does NOT count a `not_required` record. Those are the
 * top-N losers — created automatically the moment a second driver is added to a
 * one-van hire, before anyone has done anything — so counting them would flip a
 * multi-driver job to amber on arrival, which is the same lie in a new place.
 * It DOES count real money (taken/held) and any deliberate staff decision
 * (waived / rolled over / reimbursed / claimed / released).
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
     SET status = cov.target,
         updated_at = NOW()
     FROM (
       SELECT
         CASE
           -- Fully covered: every record either terminal-covered or funded.
           WHEN NOT EXISTS (
             SELECT 1 FROM job_excess je
             WHERE je.job_id = $1
               AND je.excess_status NOT IN
                 ('waived','rolled_over','not_required','reimbursed','fully_claimed','partially_reimbursed')
               AND COALESCE(je.excess_amount_taken, 0) + COALESCE(je.amount_held, 0)
                   < COALESCE(je.excess_amount_required, 0)
           ) THEN 'done'
           -- Not covered, and nothing has happened yet -> To do, not amber.
           WHEN NOT EXISTS (
             SELECT 1 FROM job_excess je3
             WHERE je3.job_id = $1
               AND (
                 COALESCE(je3.excess_amount_taken, 0) + COALESCE(je3.amount_held, 0) > 0
                 OR je3.excess_status IN
                   ('waived','rolled_over','reimbursed','fully_claimed','partially_reimbursed','released')
               )
           ) THEN 'not_started'
           ELSE 'in_progress'
         END AS target,
         EXISTS (SELECT 1 FROM job_excess je2 WHERE je2.job_id = $1) AS has_records
     ) cov
     WHERE jr.job_id = $1
       AND jr.requirement_type = 'excess'
       AND jr.phase = 'pre_hire'
       AND jr.status IN ('not_started', 'in_progress', 'done')
       AND cov.has_records
       AND jr.status <> cov.target`,
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
  // held_on_account (migration 154): a deliberately-parked excess stays 'taken'
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
             -- ...and there is actually money to resolve. A non-terminal record
             -- with £0 taken+held (e.g. a top-N loser stuck at 'needed' because
             -- the top-N wasn't recomputed after a van swap) has nothing to
             -- reimburse or claim post-hire, so it must not block the card from
             -- greening. "Did you collect it?" is a PRE-hire concern (the
             -- dispatch gate / pre-hire coverage card own that); this post-hire
             -- card is only about resolving money we actually hold.
             AND COALESCE(je.excess_amount_taken, 0) + COALESCE(je.amount_held, 0) > 0
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
