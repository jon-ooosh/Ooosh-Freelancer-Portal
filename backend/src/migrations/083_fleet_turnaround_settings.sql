-- Migration 083: Prep window threshold settings for Fleet Turnaround Schedule
--
-- The new `/vehicles` Turnaround Schedule section computes a "prep window" for
-- each van — the gap between when it's due back from one hire and when it's
-- due out on the next. Each row gets colour-coded by how comfortable that
-- window is. The thresholds below are configurable so the values can be tuned
-- without a redeploy.
--
-- The prep window is measured against `jobs.return_date` (which already
-- includes Ooosh's +1 day turnaround buffer added to `jobs.job_end`), NOT
-- the raw `job_end` — so these thresholds reflect realistic warehouse windows.
--
-- Thresholds (days):
--   > amber_threshold (default 2)  → 🟢 green   Comfortable
--   ≤ amber_threshold              → 🟡 amber   Standard turnaround
--   ≤ orange_threshold (default 1) → 🟠 orange  Eating into the +1 buffer
--   ≤ red_threshold (default 0)    → 🔴 red     Stored dates overlap — review
--
-- Lives in `vehicle_compliance_settings` because that table is already the
-- fleet-wide JSONB settings store. Not strictly compliance, but the same
-- shape and same admin surface — naming convention (prep_window_*) keeps
-- the concept distinct. If more fleet-operational knobs accumulate, this
-- can spin out into a `fleet_settings` table later.

INSERT INTO vehicle_compliance_settings (key, value) VALUES
  ('prep_window_amber_threshold_days',  '2'),
  ('prep_window_orange_threshold_days', '1'),
  ('prep_window_red_threshold_days',    '0')
ON CONFLICT (key) DO NOTHING;
