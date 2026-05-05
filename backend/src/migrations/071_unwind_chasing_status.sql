-- Migration 071: Unwind 'chasing' pipeline_status overwrites
--
-- Background
-- ----------
-- 'chasing' was historically a pipeline_status value alongside real lifecycle
-- statuses (new_enquiry, quoting, provisional, confirmed, etc.). The chase
-- auto-mover (config/scheduler.ts) ran every 15 minutes and OVERWROTE
-- pre-confirmed statuses with 'chasing' whenever next_chase_date arrived,
-- destroying the real status (e.g. a Provisional job became Chasing — its
-- "I have a deposit hold pending" state was lost).
--
-- It got worse: the chase-log handler in interactions.ts then moved
-- 'chasing' jobs back to 'new_enquiry' regardless of what they were before.
-- And lost/cancelled jobs with stale next_chase_date got dragged into
-- 'chasing' as their HH status oscillated.
--
-- Going forward
-- -------------
-- 'chasing' is a DERIVED view, not a stored status. A job is "in the chasing
-- pile" when (next_chase_date <= today AND pipeline_status IN pre-confirmed
-- stages). The Kanban renders this column from the live query. The auto-mover
-- is gone. The chase-log handler no longer touches pipeline_status.
--
-- This migration
-- --------------
-- Recovers the real status for every job currently at pipeline_status =
-- 'chasing'. Recovery strategy:
--   1. HH status (jobs.status integer) is the truth for confirmed / onwards /
--      lost / cancelled — those are unambiguous in HireHop.
--   2. For HH status 0 (Enquiry — multiple OP sub-statuses possible), look at
--      the most recent UI-initiated status_transition interaction to recover
--      paused/provisional distinctions; default to new_enquiry otherwise.
--   3. Defensive sweep: clear next_chase_date on any job that ends up in a
--      post-enquiry state (extends migration 070's pattern).
--
-- Note: pipeline_status is VARCHAR(30) with no CHECK constraint, so no
-- DB-level enum cleanup is needed. The application layer (Zod enum in
-- pipeline.ts, writeback service) is the gate that stops 'chasing' being
-- written again.

WITH chasing_jobs AS (
  SELECT j.id,
         j.status AS hh_status,
         lt.content AS ui_transition_content
  FROM jobs j
  LEFT JOIN LATERAL (
    SELECT content
    FROM interactions
    WHERE job_id = j.id
      AND type = 'status_transition'
      AND pipeline_status_at_creation IS NOT NULL  -- UI-initiated, not auto-mover
    ORDER BY created_at DESC
    LIMIT 1
  ) lt ON TRUE
  WHERE j.pipeline_status = 'chasing'
)
UPDATE jobs j
SET pipeline_status = CASE
    -- HH-derived (canonical lifecycle)
    WHEN cj.hh_status = 1 THEN 'provisional'
    WHEN cj.hh_status = 2 THEN 'confirmed'
    WHEN cj.hh_status IN (3, 4) THEN 'prepped'
    WHEN cj.hh_status = 5 THEN 'dispatched'
    WHEN cj.hh_status = 6 THEN 'returned_incomplete'
    WHEN cj.hh_status IN (7, 8) THEN 'returned'
    WHEN cj.hh_status = 9 THEN 'cancelled'
    WHEN cj.hh_status = 10 THEN 'lost'
    WHEN cj.hh_status = 11 THEN 'completed'
    -- HH = 0 (Enquiry bucket): recover OP sub-status from interaction history
    WHEN cj.ui_transition_content LIKE '%→ Paused Enquiry%' THEN 'paused'
    WHEN cj.ui_transition_content LIKE '%→ Provisional%' THEN 'provisional'
    -- Fallback: treat as new enquiry
    ELSE 'new_enquiry'
  END,
  pipeline_status_changed_at = NOW(),
  updated_at = NOW()
FROM chasing_jobs cj
WHERE j.id = cj.id;

-- Defensive sweep: clear stale next_chase_date on any job that is now in a
-- post-enquiry state. Matches migration 070's pattern. Belt-and-braces in
-- case the recovery above moved any rows out of the enquiry bucket.
UPDATE jobs
SET next_chase_date = NULL,
    updated_at = NOW()
WHERE next_chase_date IS NOT NULL
  AND pipeline_status IS NOT NULL
  AND pipeline_status NOT IN ('new_enquiry', 'quoting', 'paused', 'provisional');
