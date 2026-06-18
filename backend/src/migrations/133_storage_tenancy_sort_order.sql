-- ============================================================================
-- 133: Client Storage — manual tenancy ordering
--
-- Staff want to control the on-screen order of tenancy rows directly on the
-- Tenancies tab, INDEPENDENTLY of room order (migration 132). A live tenancy is
-- 1:1 with a room, but staff may want to arrange the two tabs differently
-- (e.g. group tenancies by client importance, not by room). A dedicated
-- sort_order on storage_tenancies decouples the two.
-- ============================================================================

ALTER TABLE storage_tenancies ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- Backfill from the current on-screen order (ended last, then room order) so
-- nothing jumps on first load.
WITH ordered AS (
  SELECT t.id, ROW_NUMBER() OVER (
    ORDER BY (t.status = 'ended'), COALESCE(r.sort_order, 2147483647), r.name
  ) * 10 AS rn
  FROM storage_tenancies t
  JOIN storage_rooms r ON r.id = t.room_id
)
UPDATE storage_tenancies t
SET sort_order = o.rn
FROM ordered o
WHERE t.id = o.id AND t.sort_order IS NULL;
