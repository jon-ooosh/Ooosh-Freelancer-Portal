-- ============================================================================
-- 254: Shop sales — receipts from the sitter till
-- ============================================================================
-- Receipts (migration 253) move to the sitter till (jon, Sep 2026). A sitter is
-- a `people` row, not a user, so a receipt records who sent it the same way a
-- sitter sale records who took it (migration 251).
-- ============================================================================

ALTER TABLE shop_receipts
  ADD COLUMN IF NOT EXISTS sent_by_person_id UUID REFERENCES people(id);
