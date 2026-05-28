-- Migration 090: Post-hire 'excess_resolve' card reflects real resolution
--
-- syncExcessRequirementStatus now also keeps the post_hire excess_resolve card
-- resolution-authoritative: 'done' only when EVERY excess record is in a
-- terminal nothing-left-to-do state, else 'in_progress' (amber). The old
-- derivation logic was forward-only (auto-resolved from not_started, never
-- demoted) and used a narrower terminal set, so a card staff marked Resolved
-- while money was still taken / pre-auth / partially reimbursed kept lying.
--
-- This one-shot backfill re-derives the status for all existing jobs.
-- Resolved set: reimbursed / fully_claimed / waived / rolled_over /
-- not_required / released. A live pre_auth is NOT resolved (decision pending).
-- Leaves 'blocked' / 'cancelled' untouched.

UPDATE job_requirements jr
SET status = CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END,
    updated_at = NOW()
FROM (
  SELECT j.id AS job_id,
    NOT EXISTS (
      SELECT 1 FROM job_excess je
      WHERE je.job_id = j.id
        AND je.excess_status NOT IN
          ('reimbursed','fully_claimed','waived','rolled_over','not_required','released')
    ) AS resolved
  FROM jobs j
  WHERE EXISTS (SELECT 1 FROM job_excess je2 WHERE je2.job_id = j.id)
) rs
WHERE jr.job_id = rs.job_id
  AND jr.requirement_type = 'excess_resolve'
  AND jr.phase = 'post_hire'
  AND jr.status IN ('not_started','in_progress','done')
  AND jr.status <> (CASE WHEN rs.resolved THEN 'done' ELSE 'in_progress' END);
