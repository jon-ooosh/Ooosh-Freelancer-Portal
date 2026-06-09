-- 111_pre_hire_review_sent_markers.sql
--
-- Persistent dedup markers for the Pre-Hire Review email.
--
-- Before this, the only dedup was a "already sent TODAY" check in the
-- scheduler (config/scheduler.ts), querying email_log for the current
-- calendar day. That meant:
--   * a manual "Pre-Hire Review" send did NOT suppress the next morning's
--     scheduled send (different calendar day), and
--   * the standard (3-day) and transport-early (5-day) windows could each
--     fire even after a manual / earlier auto send — too noisy.
--
-- New model (jon, Jun 2026): the "standard" pre-hire review fires AT MOST
-- ONCE per job (whichever of manual / 5-day / 3-day happens first wins).
-- The urgent (<=1 day, hire forms missing) warning is still allowed to fire
-- once on top of that — it's the important last-chance nudge.
--
-- Two markers, written by sendBriefingEmail():
--   * pre_hire_review_sent_at  — set on any manual / standard / transport_early send
--   * pre_hire_urgent_sent_at  — set on an urgent send
-- The scheduler's eligibility check (findEligibleJobs) skips a job for the
-- standard/transport_early triggers once pre_hire_review_sent_at is set, and
-- for the urgent trigger once pre_hire_urgent_sent_at is set.
--
-- Scoped per job row (a job's hire happens once; re-opening a cancelled job
-- creates a new row), so "ever sent" is the correct grain — no reset needed.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pre_hire_review_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_hire_urgent_sent_at TIMESTAMPTZ;

-- Backfill the review marker for jobs that already received a pre-hire
-- briefing before this column existed. Without it, a job emailed yesterday
-- (e.g. a manual test send) would still have a NULL marker and could get one
-- residual standard send at its next trigger day. We source the most recent
-- send timestamp from email_log, matching on the HH job number in the subject
-- (subjects look like "[Pre-Hire 5d] #15361 Jim Carmichael — ..."). Only the
-- standard review marker is backfilled — the urgent <=1-day nudge is left free
-- to still fire once.
UPDATE jobs j
SET pre_hire_review_sent_at = sub.last_sent
FROM (
  SELECT m.hh_num::int AS hh_num, MAX(el.created_at) AS last_sent
  FROM email_log el
  CROSS JOIN LATERAL (SELECT (regexp_match(el.subject, '#(\d+)'))[1] AS hh_num) m
  WHERE el.template_id = 'pre_hire_briefing'
    AND el.status = 'sent'
    AND m.hh_num IS NOT NULL
  GROUP BY m.hh_num
) sub
WHERE j.hh_job_number = sub.hh_num
  AND j.pre_hire_review_sent_at IS NULL;
