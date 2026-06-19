-- ============================================================================
-- 132: Client Storage — manual room ordering
--
-- Staff want to control the order rooms appear in (Rooms tab + Tenancies tab,
-- which is keyed off rooms). Until now both lists sorted by room name, which
-- looked like arbitrary insertion order. A single sort_order on storage_rooms
-- drives BOTH tabs — reorder rooms once, tenancies follow.
-- ============================================================================

ALTER TABLE storage_rooms ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- Backfill from the current name-based order so nothing jumps on first load.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name) * 10 AS rn
  FROM storage_rooms
)
UPDATE storage_rooms r
SET sort_order = o.rn
FROM ordered o
WHERE r.id = o.id AND r.sort_order IS NULL;
