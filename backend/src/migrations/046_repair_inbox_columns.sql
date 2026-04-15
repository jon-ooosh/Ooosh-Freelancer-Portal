-- ============================================================================
-- 046: Repair migration 045 — ensure all inbox columns exist
-- If migration 045 partially applied, this fills in any missing columns.
-- Safe to run multiple times (all IF NOT EXISTS).
-- ============================================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_user_id UUID;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS interaction_id UUID;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT;

-- Ensure indexes exist
CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications (user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_source
  ON notifications (source_user_id, created_at DESC)
  WHERE source_user_id IS NOT NULL;

-- Ensure user_notification_preferences table exists
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type   VARCHAR(50) NOT NULL,
  delivery_method     VARCHAR(20) DEFAULT 'both'
    CHECK (delivery_method IN ('notification', 'email', 'both', 'none')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);
