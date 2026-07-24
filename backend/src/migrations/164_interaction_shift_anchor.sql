-- 164: Interaction anchor for studio-sitter shift handover threads
--
-- Rehearsals module, Phase D slice 3. The sitter ⇄ staff handover thread reuses
-- the existing interactions stack, anchored to a shift (mirrors the issue_id /
-- held_item_id pattern). Two additions:
--
-- 1. `shift_id` — anchors an interaction to a studio_sitter_shift. Shift/handover
--    chatter is scoped OUT of the person / job / org / venue timelines by the
--    `shift_id IS NULL` guard in the read queries (same as issue_id), so it never
--    bubbles onto unrelated timelines.
--
-- 2. `author_name` — a display name for interactions authored by someone who is
--    NOT an OP user. `interactions.created_by` is a users(id) FK, but studio
--    sitters are freelancers (people, not users). A freelancer-authored handover
--    message stores created_by = NULL + author_name = the sitter's name, and the
--    read layer prefers author_name when present. General-purpose (any future
--    non-user author can use it).

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS shift_id UUID
    REFERENCES studio_sitter_shifts(id) ON DELETE SET NULL;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS author_name TEXT;

-- Partial index for the shift-thread read (WHERE shift_id = ...).
CREATE INDEX IF NOT EXISTS idx_interactions_shift
  ON interactions (shift_id)
  WHERE shift_id IS NOT NULL;
