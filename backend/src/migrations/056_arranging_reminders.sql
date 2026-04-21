-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Arranging reminders
-- Migration 056
-- ============================================================================
-- Mirrors the completion_reminder_level pattern (migration 052) but for the
-- other end of the quote lifecycle: catching transport/crew quotes that
-- have been sat in ops_status='todo' ("To Be Arranged") as the job date
-- approaches. Chaser service runs daily and sends staff emails at
-- T-5 / T-3 / T-1 days (levels 1 / 2 / 3).
--
-- Level bumped BEFORE send for idempotency (scheduler re-runs don't
-- double-send).
-- ============================================================================

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS arranging_reminder_level INTEGER DEFAULT 0;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS arranging_last_reminder_at TIMESTAMPTZ;

-- Index the chaser's scan predicate so it stays cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_quotes_arranging_chase
  ON quotes (ops_status, job_date, arranging_reminder_level)
  WHERE ops_status = 'todo' AND is_deleted = false;
