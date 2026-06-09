-- ============================================================================
-- 116: Holding — record who booked an arrival in
--
-- When staff receive a declared delivery (or log an undeclared arrival), record
-- who did it so the modal can show "Arrived <date> by <name>" instead of the
-- now-irrelevant expected/needed-by dates. See docs/HOLDING-MODULE-SPEC.md.
-- ============================================================================

ALTER TABLE held_items ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES users(id);
