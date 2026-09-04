-- Migration 196: Enquiry dismissal (dud / spam / orphan handling)
--
-- Dismissing an enquiry is distinct from Lost/Cancelled: those are real
-- commercial outcomes that belong in analytics; a dismissal means "this was
-- never a genuine enquiry" (spam, a mis-directed message, a duplicate, or an
-- orphaned web-form submission with no follow-through). We DON'T add a new
-- pipeline_status enum value — that would force auditing every
-- `NOT IN ('lost','cancelled')` filter across the codebase. Instead an overlay
-- flag on the job: the pipeline board + analytics hide `dismissed_at IS NOT NULL`,
-- and an explicit `?dismissed=1` review view surfaces them for undismiss.
--
-- The job keeps its pipeline_status (new_enquiry / quoting / paused), so
-- undismiss is a clean one-column clear — no status juggling.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dismissed_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dismissal_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dismissal_notes TEXT;

-- Partial index: the pipeline list query filters `dismissed_at IS NULL` on
-- every load, so index the (rare) dismissed rows for the `?dismissed=1` review
-- view rather than the common case.
CREATE INDEX IF NOT EXISTS idx_jobs_dismissed_at
  ON jobs (dismissed_at)
  WHERE dismissed_at IS NOT NULL;
