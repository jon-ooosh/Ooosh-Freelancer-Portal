-- ============================================================================
-- 226: One-shot marker for the last-minute booking alert
-- ============================================================================
-- The "Last-Minute Booking" email to info@ fired on "the status IS confirmed"
-- rather than "the status just BECAME confirmed" (routes/pipeline.ts). Any
-- later PATCH that set the status to 'confirmed' again re-fired it — in
-- practice a `prepped → confirmed` correction made days before the van went
-- out, on a job confirmed weeks earlier. Verified against jobs 15912, 16453
-- and 16491: all three alerted on a prepped → confirmed move, none on their
-- real confirmation. (16541 was a genuine provisional → confirmed 2 days out.)
--
-- Two guards now stand between a status write and that email. The first is the
-- from-status whitelist in services/money-emails.ts — only a transition out of
-- a pre-confirmed stage (or back from lost/cancelled) counts as winning the
-- booking. This column is the second: whatever route confirms the job, the
-- alert can only ever fire once.
--
-- WHY IT IS CLEARED ON lost/cancelled rather than being permanent:
--   A job that dies and is genuinely re-booked at short notice is a real
--   last-minute booking and deserves the alert again. Clearing on the way out
--   is the same pattern as under_dispatch_warned_at / returned_bookedout_warned_at
--   (migration 107) — drop the marker when leaving the state, so the next
--   genuine entry is allowed to warn afresh.
-- ============================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_minute_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN jobs.last_minute_alerted_at IS
  'When the last-minute booking alert was emailed to info@ for this job. Set once by sendLastMinuteAlert(); cleared when the job moves to lost/cancelled so a genuine re-booking can alert again.';
