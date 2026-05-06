-- ============================================================================
-- 076: Threaded Messaging Upgrade — Phase A foundation
-- ============================================================================
-- Adds threading + issue scoping to interactions, and an actions JSONB on
-- notifications so the inbox can render in-place action buttons (chase done,
-- mark requirement done, resend email, snooze, mark handled).
--
-- Spec: docs/MESSAGING-SPEC.md §4.1
--
-- All columns are nullable / defaulted so existing INSERTs keep working
-- without modification. No data backfill — old conversations stay flat per
-- working agreement (jon, May 2026).
-- ============================================================================

-- ── Threading on interactions ───────────────────────────────────────────────
-- A reply hangs off its parent (always the THREAD ROOT — see flatten logic in
-- routes/interactions.ts). NULL = top-level interaction (current behaviour).
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS parent_interaction_id UUID
    REFERENCES interactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_parent
  ON interactions (parent_interaction_id)
  WHERE parent_interaction_id IS NOT NULL;

-- ── Issue scoping on interactions ───────────────────────────────────────────
-- When set, the interaction is a comment on a job_issues row. ActivityTimeline
-- reads on vehicle_id / driver_id / organisation_id MUST filter
-- WHERE issue_id IS NULL so issue messages don't bubble up.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS issue_id UUID
    REFERENCES job_issues(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_issue
  ON interactions (issue_id)
  WHERE issue_id IS NOT NULL;

-- ── Actionable notifications ────────────────────────────────────────────────
-- Array of {kind, label, params, success_message?} entries. Whitelisted kinds
-- live in routes/notifications.ts:/:id/action. Empty array = no buttons
-- (current behaviour for every existing notification).
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '[]';
