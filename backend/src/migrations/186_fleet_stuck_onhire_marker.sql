-- 186 — Fleet "stuck On Hire" detection-scanner dedup marker
--
-- Adds `fleet_vehicles.stuck_onhire_alerted_at TIMESTAMPTZ` — the dedup marker
-- for the multi-van book-out scramble detection scanner (see
-- docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md §6).
--
-- The scanner flags a van reading `hire_status='On Hire'` that has NO live
-- `booked_out`/`active` vehicle_hire_assignments row — the fingerprint of the
-- scramble bug (the 2nd van's rows had their `vehicle_id` overwritten to the
-- other van, so the van is projected "On Hire" but owns no assignment). It
-- emails jon@ once per stuck van and stamps this marker (stamp-first, like the
-- sibling scanners in services/sanity-check-scanner.ts).
--
-- The marker is CLEARED inside syncFleetHireStatus() whenever the van leaves
-- 'On Hire' (nextStatus !== 'On Hire'), so a re-entered stuck state alerts
-- afresh. Additive + nullable — existing rows are no-ops.
ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS stuck_onhire_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN fleet_vehicles.stuck_onhire_alerted_at IS
  'Stamped by the stuck-On-Hire detection scanner after firing one alert. Cleared in syncFleetHireStatus when the van leaves On Hire. See docs/MULTI-VAN-BOOKOUT-SCRAMBLE.md.';
