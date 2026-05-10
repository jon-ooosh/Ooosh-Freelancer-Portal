-- ============================================================================
-- 080: Per-user thread mutes
-- ============================================================================
-- Lets a user opt out of further "replied in a thread" re-notifications for
-- a specific thread root. Doesn't affect anyone else; the thread itself
-- stays open and reply notifications still fire for everyone who hasn't
-- muted it.
--
-- Storage as a separate table (not a JSONB column on users) because:
--   - lookups happen at notification-create time per-recipient — a small
--     PRIMARY KEY (user_id, root_interaction_id) gives fast existence
--     checks without scanning a JSONB array
--   - cascading on interaction delete keeps housekeeping simple
--
-- The check is intentionally only applied to thread re-notifications
-- (priority='low' "replied in a thread you're in" rows). Explicit
-- @mentions still fire even if the thread is muted — if someone @s you,
-- you should see it. Matches the working agreement (jon, May 2026):
-- "want to thumbs-up things that don't really warrant anything else", but
-- not at the cost of missing direct calls for attention.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_muted_threads (
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_interaction_id  UUID NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  muted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, root_interaction_id)
);

CREATE INDEX IF NOT EXISTS idx_user_muted_threads_user
  ON user_muted_threads (user_id);
