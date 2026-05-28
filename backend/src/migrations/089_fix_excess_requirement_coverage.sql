-- Migration 089: Excess requirement light reflects REAL coverage
--
-- Background: syncExcessRequirementStatus used to promote the pre-hire excess
-- requirement to 'done' (green) whenever ANY covered job_excess record existed,
-- including `not_required` records. On a multi-driver / single-van self-drive
-- job the top-N-drivers algorithm leaves one chargeable driver (£1,200 needed)
-- plus a `not_required` sibling — so the requirement showed a false green even
-- with the excess uncollected, and counted toward the pre-hire 3/3 bar.
--
-- The service function is now coverage-authoritative (done only when EVERY
-- record is covered, else in_progress). This one-shot backfill re-derives the
-- status for all existing jobs so historical false-greens correct immediately.
--
-- Coverage rule mirrors money.ts isCovered: terminal-covered = waived /
-- rolled_over / not_required / reimbursed / fully_claimed / partially_reimbursed;
-- 'released' is NOT covered. Leaves 'blocked' / 'cancelled' untouched.

UPDATE job_requirements jr
SET status = CASE WHEN cov.covered THEN 'done' ELSE 'in_progress' END,
    updated_at = NOW()
FROM (
  SELECT j.id AS job_id,
    NOT EXISTS (
      SELECT 1 FROM job_excess je
      WHERE je.job_id = j.id
        AND je.excess_status NOT IN
          ('waived','rolled_over','not_required','reimbursed','fully_claimed','partially_reimbursed')
        AND COALESCE(je.excess_amount_taken, 0) + COALESCE(je.amount_held, 0)
            < COALESCE(je.excess_amount_required, 0)
    ) AS covered
  FROM jobs j
  WHERE EXISTS (SELECT 1 FROM job_excess je2 WHERE je2.job_id = j.id)
) cov
WHERE jr.job_id = cov.job_id
  AND jr.requirement_type = 'excess'
  AND jr.phase = 'pre_hire'
  AND jr.status IN ('not_started','in_progress','done')
  AND jr.status <> (CASE WHEN cov.covered THEN 'done' ELSE 'in_progress' END);
