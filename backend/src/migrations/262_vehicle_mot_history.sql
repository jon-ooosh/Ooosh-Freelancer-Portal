-- 262_vehicle_mot_history.sql
-- DVSA MOT history per van (docs/VEHICLE-SALES-SPEC.md §3).
--
-- One row per van, overwritten on each fetch. The DVSA response is stored
-- as-is in `payload` so a field we don't display yet is never lost; the UI
-- parses it. A failed fetch keeps the last good payload and records the
-- error alongside, so a DVSA outage never blanks the history.
--
-- Refreshed weekly (Mon 07:30, before the 08:00 compliance check), on demand
-- from the Vehicle Detail MOT history section, and when a sale starts.

CREATE TABLE IF NOT EXISTS vehicle_mot_history (
  vehicle_id       UUID PRIMARY KEY REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  payload          JSONB,                 -- last good DVSA response (NULL until one succeeds)
  fetched_at       TIMESTAMPTZ,           -- when `payload` was fetched
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT                   -- NULL when the last attempt succeeded
);
