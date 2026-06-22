-- 142_vehicle_forecast_assessments.sql
-- AI-generated fleet health assessments for the Vehicle > Forecast tab.
--
-- One row per generation; the Forecast tab reads the latest by generated_at.
-- Regenerated 3x/week by the scheduler (Sun 18:00 / Wed 07:00 / Fri 07:00
-- Europe/London) and on-demand via the "Regenerate" button. History is kept
-- (we insert, never update) so we can see how a van's health narrative moved
-- over time. The deterministic forecast cards are computed live and NOT stored
-- here — only the AI narrative + structured recommendations are cached.

CREATE TABLE IF NOT EXISTS vehicle_forecast_assessments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  headline         TEXT,                          -- one-line health summary
  summary          TEXT,                          -- 2-4 sentence narrative
  watch_items      JSONB NOT NULL DEFAULT '[]',   -- [{ label, detail, severity }]
  recommendations  JSONB NOT NULL DEFAULT '[]',   -- [{ action, reason, priority }]
  overall_status   VARCHAR(20),                   -- good | watch | attention
  model            VARCHAR(60),                   -- claude model id used
  trigger          VARCHAR(20) NOT NULL DEFAULT 'scheduled',  -- scheduled | manual
  generated_by     UUID REFERENCES users(id),     -- null for scheduled runs
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_forecast_assessments_vehicle
  ON vehicle_forecast_assessments (vehicle_id, generated_at DESC);
