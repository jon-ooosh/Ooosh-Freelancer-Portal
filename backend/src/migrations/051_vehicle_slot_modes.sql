-- Migration 051: Per-van self-drive/van-and-driver slot modes
--
-- Replaces the job-level `is_van_and_driver` boolean with a per-slot map.
-- Each vehicle line item on a HireHop job can have multiple slots (qty > 1),
-- and each slot can independently be either self-drive or van-and-driver.
--
-- Shape:
--   { "<ITEM_ID>": ["self_drive", "van_and_driver", ...], ... }
-- Array index = slot index within that line. Missing entries default to
-- 'self_drive'. Entries beyond current qty are preserved so toggle state
-- survives temporary qty changes in HireHop.
--
-- Migration of existing data: jobs with is_van_and_driver = true get ALL
-- their current vehicle lines marked as van_and_driver for every slot.
-- Jobs with is_van_and_driver = false get an empty map (all slots default
-- to self_drive). The old column is kept for one release as a safety net
-- and will be dropped in a follow-up migration.

BEGIN;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS vehicle_slot_modes JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN jobs.vehicle_slot_modes IS
  'Per-vehicle-slot mode overrides, keyed by HH ITEM_ID. Value is an array of modes indexed by slot (e.g. ["self_drive","van_and_driver"] means slot 0 is self-drive, slot 1 is van-and-driver). Missing entries default to self_drive.';

-- Backfill: for jobs currently flagged is_van_and_driver=true, mark every
-- slot of every vehicle line as 'van_and_driver'.
UPDATE jobs j
SET vehicle_slot_modes = (
  SELECT COALESCE(
    jsonb_object_agg(
      (item->>'ITEM_ID'),
      (
        SELECT jsonb_agg('van_and_driver'::text)
        FROM generate_series(1, GREATEST(1, COALESCE((item->>'QUANTITY')::numeric, 1)::int))
      )
    ),
    '{}'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(j.line_items, '[]'::jsonb)) AS item
  WHERE (item->>'CATEGORY_ID')::int = 370
    AND (item->>'kind')::int = 2
    AND COALESCE((item->>'VIRTUAL')::int, 0) = 0
)
WHERE j.is_van_and_driver = true;

COMMIT;
