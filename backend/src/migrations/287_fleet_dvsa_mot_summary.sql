-- 287_fleet_dvsa_mot_summary.sql
-- DVSA becomes THE source of a van's MOT Due date (jon, 14 Oct 2026 —
-- docs/VEHICLE-SALES-SPEC.md §16). fleet_vehicles.mot_due stays the one date
-- every screen and the compliance check read; this records where it came from
-- and a small DVSA summary so the fleet board can flag things without parsing
-- every van's full MOT history.
--
-- mot_due_source:
--   'dvsa'   — mot_due is DVSA's date (or someone typed exactly DVSA's date)
--   'manual' — typed by staff and different from DVSA. Kept only while it is
--              LATER than DVSA's (the hours after a pass, before DVSA shows it);
--              an earlier or equal DVSA date, or a newer DVSA test, replaces it.
--   NULL     — never reconciled (existing rows); the next DVSA refresh sets it.
--
-- The dvsa_* columns are a cache written ONLY by services/dvsa-mot.ts
-- refreshVehicleMot(); the full record stays in vehicle_mot_history.

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS mot_due_source      VARCHAR(10)
  CHECK (mot_due_source IN ('dvsa', 'manual'));
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_mot_due        DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_advisories     INTEGER;      -- advisory + minor items on the latest test
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_recall         VARCHAR(20);  -- Yes / No / Unknown / Unavailable
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_latest_result  VARCHAR(10);  -- PASSED / FAILED
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_latest_test_on DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS dvsa_checked_at     TIMESTAMPTZ;  -- last SUCCESSFUL fetch
