-- Migration 085: Person↔Organisation role picklist tidy-up
-- ------------------------------------------------------------------------
-- Three changes to bring the role taxonomy in line with how staff actually
-- describe people at organisations:
--
--   1. Rename "Agent" → "Booking Agent" (clarity — booking agents are a
--      specific role at management companies; the bare "Agent" was
--      ambiguous and could be confused with talent/literary agents).
--   2. Backfill any null/empty roles to "General Contact" so every linkage
--      has a meaningful role for Phase 4 (role-keyed email routing).
--   3. (Picklist additions live in shared/types/index.ts — no data writes
--      needed for those since the column is free-text VARCHAR.)
--
-- `person_organisation_roles.role` is VARCHAR(255), free-text, picklist
-- enforced at the UI layer. We touch the existing rows only.
-- ------------------------------------------------------------------------

-- Rename Agent → Booking Agent on existing rows.
UPDATE person_organisation_roles
SET role = 'Booking Agent', updated_at = NOW()
WHERE role = 'Agent';

-- Backfill empty / null roles to General Contact. NOT NULL constraint is
-- already in place per the original schema (001_foundation.sql), so a null
-- shouldn't strictly exist — this catches any whitespace-only rows that
-- slipped past the constraint.
UPDATE person_organisation_roles
SET role = 'General Contact', updated_at = NOW()
WHERE role IS NULL OR TRIM(role) = '';
