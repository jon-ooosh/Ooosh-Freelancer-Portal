-- Migration 064: keep_after_close flag on job_requirements
--
-- When a job is moved to Lost or Cancelled, all open requirements (reminders,
-- hire forms, excess, vehicle prep, etc.) should normally stop firing. The
-- Lost / Cancelled modal lets staff tick which open requirements to keep
-- alive — typical case is a post-cancellation client follow-up or a "chase
-- the deposit refund" reminder.
--
-- Requirements that are kept get keep_after_close = true. Background scanners
-- (reminder scanner, close-out scanner, hire-form auto-emailer, etc.) check
-- this flag when the parent job is in lost/cancelled status and skip the
-- requirement unless it's explicitly opted-in.
--
-- See CLAUDE.md → "Lost / Cancelled cleanup pattern" for the full pattern.

ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS keep_after_close BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN job_requirements.keep_after_close IS
  'If true, this requirement survives the parent job moving to lost/cancelled. Set via the cleanup section in the Lost/Cancelled modal.';
