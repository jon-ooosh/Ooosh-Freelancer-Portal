-- ============================================================================
-- 149: Held-item scoping on interactions
-- ============================================================================
-- Lets the "Held for Clients" / Lost Property / temp-storage records carry a
-- proper @mentionable discussion thread, reusing the existing interactions
-- messaging layer (mirrors the issue_id pattern added in migration 076).
--
-- When set, the interaction is a comment on a held_items row. Entity-timeline
-- reads (person / org / job / venue) MUST filter WHERE held_item_id IS NULL so
-- held-item chatter doesn't bubble onto a client's address-book or job timeline.
--
-- Nullable / no backfill — existing INSERTs keep working unchanged.
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS held_item_id UUID
    REFERENCES held_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_held_item
  ON interactions (held_item_id)
  WHERE held_item_id IS NOT NULL;
