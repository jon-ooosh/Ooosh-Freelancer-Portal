-- ============================================================================
-- 115: Holding — client contact fields for notifications
--
-- The inbound merch form captures a contact email/phone. Store them as proper
-- columns (was stuffed into notes) so the "Notify client" action can actually
-- email the right person. See docs/HOLDING-MODULE-SPEC.md.
-- ============================================================================

ALTER TABLE held_items ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE held_items ADD COLUMN IF NOT EXISTS contact_phone TEXT;
