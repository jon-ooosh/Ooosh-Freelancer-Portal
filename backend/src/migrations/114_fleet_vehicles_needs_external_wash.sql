-- 114_fleet_vehicles_needs_external_wash.sql
--
-- "Needs external wash" marker on the fleet.
--
-- A van awaiting a trip to the carwash is a prep TO-DO, not a fault, so it
-- must NOT spawn a Problems-register issue (the "Bodywork → To be cleaned"
-- prep answer is de-flagged in the checklist settings). Instead it sets this
-- lightweight marker, surfaced as a non-blocking badge on the fleet board,
-- vehicle detail, turnaround schedule, and book-out flow.
--
-- Set when a prep records the bodywork as "To be cleaned"; cleared either by
-- a later prep recording "Washed and clean" or by staff clicking
-- "Mark as washed" (PATCH /api/vehicles/fleet/:id/mark-washed).

ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS needs_external_wash BOOLEAN NOT NULL DEFAULT FALSE;
