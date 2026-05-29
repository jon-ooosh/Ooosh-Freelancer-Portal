-- 096_fleet_gearbox.sql
-- Promote gearbox to an explicit, editable column on fleet_vehicles.
--
-- Until now gearbox was inferred at match-time by parsing the free-text
-- vehicle_type label for an "(A)"/"(M)" marker (van-matching.ts getGearbox).
-- That worked for vans imported from the Monday Fleet Master (which always
-- carry the marker) but left no way to set it in the UI — a manually-added
-- Premium/Basic/Vito van could end up gearbox-"unknown" and mis-match auto vs
-- manual job requirements. This adds a first-class column the fleet UI can
-- edit, backfilled from the existing label so nothing regresses.

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS gearbox VARCHAR(10);

-- Backfill from the existing vehicle_type label's (A)/(M) marker.
UPDATE fleet_vehicles
SET gearbox = CASE
  WHEN vehicle_type ILIKE '%(A)%' THEN 'auto'
  WHEN vehicle_type ILIKE '%(M)%' THEN 'manual'
  ELSE gearbox
END
WHERE gearbox IS NULL;
