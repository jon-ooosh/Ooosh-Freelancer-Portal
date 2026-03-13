-- Migration 015: Extended vehicle details
--
-- Adds: maintenance specifics (oil, coolant, tyre size),
-- Rossetts service tracking, service plan status,
-- and general vehicle file storage.

-- Maintenance specifics
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS oil_type VARCHAR(50);           -- e.g. "5W-30"
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS coolant_type VARCHAR(50);       -- e.g. "Blue", "Pink"
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS tyre_size VARCHAR(50);          -- e.g. "235/65/R16"

-- Rossetts service tracking
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS last_rossetts_service_date DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS last_rossetts_service_notes TEXT;

-- Service plan status
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS service_plan_status VARCHAR(50); -- '0 Remaining'..'6 Remaining', 'WORKINGONIT', 'NO PLAN'

-- General vehicle files (V5 copy, insurance cert, wifi docs, finance docs, etc.)
-- Same JSONB structure as service_log files: [{name, label, comment, url, type, uploaded_at, uploaded_by}]
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]';
