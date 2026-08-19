-- 173: Not-submitted lock-up chaser dedup marker
--
-- The morning-after accountability nudge (runLockupChase) fires ONCE per shift
-- that closed without a lock-up report. This column is the per-shift dedup stamp
-- (set stamp-first, before the emails, so a transient send failure can't re-fire
-- the chase on the next scheduler pass).

ALTER TABLE studio_sitter_shifts
  ADD COLUMN IF NOT EXISTS lockup_chase_sent_at TIMESTAMPTZ;
