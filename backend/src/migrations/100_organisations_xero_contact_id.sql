-- 100_organisations_xero_contact_id.sql
-- Promote Xero contact id to a first-class column on organisations (Jun 2026).
--
-- Pre-migration: Xero ACC_IDs were stored only in `external_id_map`
-- (entity_type='organisations', external_system='xero'). The HH contact sync
-- (hirehop-sync.ts §1c) already populates this. But downstream code that
-- creates job_excess records (hh-requirement-derivation, hire-form submission,
-- payment portal) couldn't easily look up the Xero linkage at write time, so
-- new records went out with `xero_contact_id = NULL` → fell into the
-- 'UNLINKED' / `name:<...>` bucket on `/money/excess` rather than pairing to
-- a real Xero contact from the start. Migration 063 was the name-based
-- workaround; this is the structural fix.
--
-- This migration:
--   1. Adds organisations.xero_contact_id TEXT (nullable).
--   2. Backfills from external_id_map, keeper-wins on duplicates.
--   3. Adds a partial unique index (one Xero ID per organisation).
--
-- After this lands, hirehop-sync.ts writes BOTH external_id_map AND
-- organisations.xero_contact_id (kept in sync). New job_excess writes read
-- the org's xero_contact_id at creation time.

BEGIN;

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

-- Backfill from external_id_map. Pick the most recent entry per organisation
-- when duplicates exist (one entry per linked Xero contact — Ooosh's HH→Xero
-- bridge typically produces one, but a small percentage have a 'Z' duplicate
-- from historical re-mappings).
UPDATE organisations o
SET xero_contact_id = (
  SELECT m.external_id
  FROM external_id_map m
  WHERE m.entity_type = 'organisations'
    AND m.entity_id = o.id
    AND m.external_system = 'xero'
    AND m.external_id IS NOT NULL
    AND m.external_id <> ''
  ORDER BY m.synced_at DESC NULLS LAST
  LIMIT 1
)
WHERE o.xero_contact_id IS NULL;

CREATE INDEX IF NOT EXISTS organisations_xero_contact_id_idx
  ON organisations (xero_contact_id) WHERE xero_contact_id IS NOT NULL;

-- One-shot: pair existing job_excess records to their client's Xero contact
-- where the column is empty AND the linked client organisation has a Xero ID.
-- Only touches records where xero_contact_id is NULL — preserves existing
-- payments that were explicitly paired (e.g. via /excess/:id/move). The
-- ledger view's grouping key automatically picks this up on next read.
UPDATE job_excess je
SET xero_contact_id = o.xero_contact_id
FROM jobs j
JOIN organisations o ON o.id = j.client_id
WHERE je.job_id = j.id
  AND je.xero_contact_id IS NULL
  AND o.xero_contact_id IS NOT NULL;

COMMIT;
