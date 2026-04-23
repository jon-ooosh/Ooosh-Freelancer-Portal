-- Migration 061: chase alert recipient + delivery preference on jobs
--
-- Staff can now choose, when logging or rescheduling a chase:
--   - WHO gets notified when the chase becomes due (chase_alert_user_id)
--   - HOW they get notified (chase_alert_delivery: 'bell' or 'bell_email')
--
-- Stored on jobs (not interactions) so the preference persists across
-- reschedules and log-chase events without needing to re-pick each time.
-- The auto-mover scheduler reads these fields when the chase date arrives
-- and creates a chase_alert notification with priority set accordingly
-- ('normal' for bell, 'urgent' for bell_email — urgent triggers immediate
-- email via the existing escalation scheduler).

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS chase_alert_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chase_alert_delivery VARCHAR(20)
    CHECK (chase_alert_delivery IN ('bell', 'bell_email'));

CREATE INDEX IF NOT EXISTS idx_jobs_chase_alert_user ON jobs (chase_alert_user_id)
  WHERE chase_alert_user_id IS NOT NULL;
