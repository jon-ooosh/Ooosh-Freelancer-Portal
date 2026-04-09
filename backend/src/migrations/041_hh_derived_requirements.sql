-- Migration 041: HH-Derived Requirements Engine foundation
--
-- 1. Add seat_layout to fleet_vehicles (for cross-referencing seat config on jobs)
-- 2. Enrich the line_items JSONB format to include kind, AUTOPULL, TYPE_CUSTOM_FIELDS,
--    VIRTUAL, LFT, RGT — needed for HH-derived requirement detection
-- 3. Add hh_derived_flags JSONB on jobs for caching derived requirement flags
-- 4. Add source metadata fields to job_requirements for HH sync tracking

-- ── 1. Fleet vehicle seat layout ──────────────────────────────────────────

ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS seat_layout VARCHAR(30); -- 'round_table' | 'forward_facing' | NULL (unknown)

COMMENT ON COLUMN fleet_vehicles.seat_layout IS 'Current seat configuration: round_table or forward_facing. Populated via prep forms. NULL = not yet recorded.';

-- ── 2. No schema change needed for line_items ─────────────────────────────
-- line_items is already JSONB (migration 033). We just need to store richer objects.
-- Old format: [{ ITEM_ID, ITEM_NAME, QUANTITY, CATEGORY_ID }]
-- New format: [{ ITEM_ID, ITEM_NAME, QUANTITY, CATEGORY_ID, kind, AUTOPULL, VIRTUAL, LFT, RGT, LIST_ID, TYPE_CUSTOM_FIELDS, title }]
-- The sync code change handles this — no migration needed.

-- ── 3. Derived flags cache on jobs ────────────────────────────────────────
-- Stores the last-derived requirement flags from HH line items so we can detect changes.
-- Format: { has_vehicle: true, seat_config: 'forward_facing', has_backline: true, ... }

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS hh_derived_flags JSONB DEFAULT NULL;

-- Last time line items were synced (separate from updated_at which changes on any field)
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS line_items_synced_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN jobs.hh_derived_flags IS 'Cached flags derived from HH line items. Used to detect changes between syncs.';
COMMENT ON COLUMN jobs.line_items_synced_at IS 'When line items were last fetched from HireHop (distinct from updated_at).';

-- ── 4. Extend job_requirements for HH sync metadata ──────────────────────
-- source and is_auto already exist from migration 021. Add fields for mismatch tracking.

ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS hh_item_snapshot JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hh_mismatch BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS hh_mismatch_detail TEXT DEFAULT NULL;

COMMENT ON COLUMN job_requirements.hh_item_snapshot IS 'Snapshot of the HH line item(s) that generated this requirement. Used to detect if HH changed.';
COMMENT ON COLUMN job_requirements.hh_mismatch IS 'True if HH data has changed since staff last acted on this requirement.';
COMMENT ON COLUMN job_requirements.hh_mismatch_detail IS 'Human-readable description of what changed in HH.';

-- ── 5. Van & Driver override flag on jobs ─────────────────────────────────
-- Default is self-drive. When toggled, hire_forms + excess requirements are NOT auto-created.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS is_van_and_driver BOOLEAN DEFAULT false;

COMMENT ON COLUMN jobs.is_van_and_driver IS 'Override: true = van & driver (no hire forms/excess needed). Default false = self-drive.';

-- ── Permissions for backup user ───────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON fleet_vehicles TO ooosh_backup;
    GRANT SELECT ON job_requirements TO ooosh_backup;
  END IF;
END $$;
