-- Migration 088: Fleet service alerts — mileage-based service + Rossetts annual warranty
--
-- Two distinct service concepts, both now surfaced as daily compliance alerts
-- (08:00 scan, same email/bell plumbing as MOT/Tax/Insurance/TFL):
--
--   1. General service  — MILEAGE based, all vans. Alert when
--      (next_service_due - current_mileage) <= service_mileage_warning_miles.
--      This catches the "van is N miles off a service, get it booked before it
--      goes out on a long hire" case.
--
--   2. Rossetts service — DATE based, Mercedes/on-plan vans only. The rolling
--      warranty with the Merc dealership must be done at least once a year
--      after the initial 3-year standard warranty. Next due:
--        - last_rossetts_service_date + rossetts_interval_months  (if serviced before)
--        - date_first_reg + rossetts_first_service_years          (first service)
--
-- `rossetts_applicable` flags which vans are on the plan. Defaulted true for
-- Mercedes makes (excluding any explicitly marked "NO PLAN") so the existing
-- fleet behaves sensibly; staff toggle per van from the vehicle settings page.
-- VW/Ford etc. stay false → no Rossetts alerts.

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS rossetts_applicable BOOLEAN NOT NULL DEFAULT false;

UPDATE fleet_vehicles
SET rossetts_applicable = true
WHERE (make ILIKE '%mercedes%' OR make ILIKE '%merc%')
  AND COALESCE(service_plan_status, '') <> 'NO PLAN'
  AND rossetts_applicable = false;

-- Fleet-wide alert thresholds (JSONB key/value store, same table as the
-- MOT/Tax/Insurance/TFL warning/urgent days). Editable from the vehicle
-- settings page without a redeploy.
INSERT INTO vehicle_compliance_settings (key, value) VALUES
  ('service_mileage_warning_miles', '2000'),   -- alert this many miles before next_service_due
  ('rossetts_first_service_years',  '3'),      -- years from first registration to the first Rossetts service
  ('rossetts_interval_months',      '12'),     -- months between Rossetts services thereafter
  ('rossetts_warning_days',         '30')      -- days before the Rossetts due date to start alerting
ON CONFLICT (key) DO NOTHING;
