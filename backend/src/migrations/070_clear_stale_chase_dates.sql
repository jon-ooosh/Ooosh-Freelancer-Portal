-- Migration 070: Clear stale next_chase_date on post-enquiry jobs
--
-- Chase dates are a pre-confirmation concept. Going forward the application
-- now nulls next_chase_date when a job moves out of an enquiry stage (see
-- pipeline.ts /:id/status and the HireHop webhook handlers).
--
-- This one-shot pass cleans up historical drift: jobs that progressed to
-- confirmed / cancelled / any operational status before the new clearing
-- logic landed kept their stale chase date, which was inflating the
-- dashboard "Chases Due" bucket with completed jobs (e.g. Tatty Seaside
-- Town, TESTING 123 Ltd, Toma Lazarov surfacing as "30+ days overdue
-- chase" months after the hire ended).
--
-- Pre-confirmation enquiry stages (where a chase date is meaningful):
--   new_enquiry, quoting, chasing, paused, provisional
-- Anything else: clear it.

UPDATE jobs
SET next_chase_date = NULL,
    updated_at = NOW()
WHERE next_chase_date IS NOT NULL
  AND pipeline_status IS NOT NULL
  AND pipeline_status NOT IN ('new_enquiry', 'quoting', 'chasing', 'paused', 'provisional');
