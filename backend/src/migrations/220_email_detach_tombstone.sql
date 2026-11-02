-- 220_email_detach_tombstone.sql
-- Auto-Chase filtering foundation, round 2 (Sep 2026).
--
-- Detach ("Not this job") used to null job_id, so the email vanished entirely —
-- no way to recall it if the detach was a mistake. Switch to a tombstone: the
-- email STAYS on the job (job_id untouched) but is flagged detached, rendered as
-- a greyed one-line "removed from this job · Re-attach" row (like the
-- "Status changed: prepped → Confirmed" system lines). Excluded from the AI reads
-- (summary / dispute helper) so it's functionally off the job, but recoverable.
--
-- Additive/nullable. Re-attach clears both columns; a move re-homes the email and
-- clears them too.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS detached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detached_by UUID REFERENCES users(id);
