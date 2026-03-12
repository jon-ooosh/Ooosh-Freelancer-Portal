-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Fix: Update interactions type CHECK constraint
-- Migration 005: Allow 'chase' and 'status_transition' interaction types
-- ============================================================================
-- Migration 004 added these to the picklist but didn't update the CHECK
-- constraint on interactions.type, causing INSERT failures.
-- ============================================================================

-- Drop the old constraint and add the expanded one
ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_type_check;
ALTER TABLE interactions ADD CONSTRAINT interactions_type_check
  CHECK (type IN ('note', 'email', 'call', 'meeting', 'mention', 'chase', 'status_transition'));
