-- Migration 089: New-vehicle setup checklist
--
-- When a van is added to the fleet there's a set of off-system jobs that are
-- easy to forget (add to the fleet insurance policy, add to TTS360, log MOT/Tax
-- dates, add to HireHop, etc.). This column stores a per-vehicle checklist of
-- those tasks so nothing slips through when onboarding a new vehicle.
--
-- Shape: JSONB array of { key, label, done, doneAt, doneBy }.
-- An EMPTY array means "no checklist started" — legacy vehicles default to this
-- and are NOT treated as "setup pending". A vehicle is only "setup pending" when
-- the array is non-empty AND at least one item is not done. New vehicles created
-- via the Add Vehicle form get the checklist seeded, so they flag until complete.

ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS setup_checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
