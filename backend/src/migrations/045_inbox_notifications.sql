-- ============================================================================
-- 045: Inbox & Notification System
-- Extends notifications table for messaging, escalation, and follow-ups.
-- Adds user notification preferences table.
-- ============================================================================

-- ── Extend notifications table ──────────────────────────────────────────────

-- Priority: controls escalation timing
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal'
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

-- Who created this notification (for @mentions: the author; for system: NULL)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_user_id UUID REFERENCES users(id);

-- Links to the interaction that triggered this (for @mention threading)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS interaction_id UUID;

-- Acknowledged: explicit "I've dealt with this" (stronger than read)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- Escalation tracking
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;

-- Nudge: sender can re-surface an unread notification
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS nudged_at TIMESTAMPTZ;

-- Follow-up reminders: when this notification should surface
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

-- Snooze: hide from inbox until this date
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- Deep link to relevant page (e.g. /jobs/uuid, /vehicles/drivers/uuid)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url TEXT;

-- Index for inbox queries: unread, un-snoozed, ordered by priority then date
CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications (user_id, is_read, snoozed_until, priority, created_at DESC);

-- Index for escalation scheduler: unread notifications needing email
CREATE INDEX IF NOT EXISTS idx_notifications_escalation
  ON notifications (is_read, email_sent_at, priority, created_at)
  WHERE is_read = false AND email_sent_at IS NULL;

-- Index for follow-up due dates
CREATE INDEX IF NOT EXISTS idx_notifications_due_date
  ON notifications (due_date)
  WHERE due_date IS NOT NULL AND acknowledged_at IS NULL;

-- Index for sent view: notifications by source user
CREATE INDEX IF NOT EXISTS idx_notifications_source
  ON notifications (source_user_id, created_at DESC)
  WHERE source_user_id IS NOT NULL;

-- ── User notification preferences ───────────────────────────────────────────

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

-- ── Seed default notification types for reference ───────────────────────────
-- (Users can override per-type via user_notification_preferences)
-- Types: mention, chase_alert, compliance, hire_form, referral, follow_up, system
