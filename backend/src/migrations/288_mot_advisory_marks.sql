-- 288_mot_advisory_marks.sql
-- Ticking off DVSA advisories (jon, 15 Oct 2026 — docs/VEHICLE-SALES-SPEC.md §18).
--
-- DVSA's record can't be edited, so we record what WE did about each advisory /
-- minor item on a van's LATEST MOT test: 'done' (dealt with) or 'noted' (seen,
-- not fixed yet), with an optional note and who/when.
--
-- A mark belongs to ONE test (test_key = DVSA's test number). A new MOT has a
-- new test number, so its advisories start open again — a repeat advisory is
-- the tester seeing it again, and should show again.
--
-- defect_key = "TYPE|text#n" (n = 1 for the first identical item on that test),
-- built by services/dvsa-mot.ts advisoryKey(). Never hand-written.
--
-- fleet_vehicles.dvsa_advisories_open is the fleet board's chip count — the
-- latest test's advisories with no mark. Written ONLY by dvsa-mot.ts
-- recountOpenAdvisories() (after a refresh and after every mark / unmark).

CREATE TABLE IF NOT EXISTS vehicle_mot_advisory_marks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id  UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  test_key    TEXT NOT NULL,
  defect_key  TEXT NOT NULL,
  state       VARCHAR(10) NOT NULL CHECK (state IN ('done', 'noted')),
  note        TEXT,
  marked_by   UUID REFERENCES users(id),
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vehicle_id, test_key, defect_key)
);

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_advisories_open INTEGER;

-- Until each van's next refresh / mark, every advisory counts as open.
UPDATE fleet_vehicles SET dvsa_advisories_open = dvsa_advisories
 WHERE dvsa_advisories_open IS NULL AND dvsa_advisories IS NOT NULL;
