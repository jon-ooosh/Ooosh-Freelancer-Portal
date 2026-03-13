-- Migration 014: Vehicle Maintenance & Compliance
--
-- Adds:
--   1. Insurance & booked-in date fields on fleet_vehicles
--   2. Extended service_log fields (AI extraction, files, next-due tracking)
--   3. vehicle_mileage_log table (structured mileage history)
--   4. vehicle_fuel_log table (fuel cost tracking)
--   5. vehicle_compliance_settings table (thresholds & notification config)

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Extend fleet_vehicles
-- ═══════════════════════════════════════════════════════════════════════════

-- Insurance tracking
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS insurance_due DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS insurance_provider VARCHAR(255);
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS insurance_policy_number VARCHAR(100);

-- "Booked in" dates — appears when a compliance item enters warning window
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS mot_booked_in_date DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS service_booked_in_date DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS insurance_booked_in_date DATE;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS tax_booked_in_date DATE;

-- Current mileage (updated from events, services, manual entry)
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS current_mileage INTEGER;
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS last_mileage_update TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Extend vehicle_service_log
-- ═══════════════════════════════════════════════════════════════════════════

-- Next-due tracking (populated from service records or AI extraction)
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS next_due_date DATE;
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS next_due_mileage INTEGER;

-- AI extraction fields
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS ai_extracted BOOLEAN DEFAULT false;

-- File attachments (JSONB array of {name, url, type, size})
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]';

-- Who created this record
ALTER TABLE vehicle_service_log ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Vehicle mileage log — structured history from events + services
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_mileage_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  mileage       INTEGER NOT NULL,
  source        VARCHAR(50) NOT NULL,    -- book_out, check_in, prep, service, manual
  source_ref    VARCHAR(255),            -- R2 event ID, service_log ID, etc.
  recorded_at   TIMESTAMPTZ DEFAULT NOW(),
  recorded_by   UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_mileage_log_vehicle ON vehicle_mileage_log (vehicle_id, recorded_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Vehicle fuel log — fuel cost tracking
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_fuel_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id    UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  litres        DECIMAL(8,2),
  cost          DECIMAL(10,2) NOT NULL,
  mileage_at_fill INTEGER,
  full_tank     BOOLEAN DEFAULT false,
  receipt_file  JSONB,                   -- {name, url, type, size}
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_fuel_log_vehicle ON vehicle_fuel_log (vehicle_id, date DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Vehicle compliance settings — thresholds & notification config
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_compliance_settings (
  key           VARCHAR(100) PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID REFERENCES users(id)
);

-- Default settings
INSERT INTO vehicle_compliance_settings (key, value) VALUES
  ('mot_warning_days',          '30'),
  ('mot_urgent_days',           '7'),
  ('service_warning_days',      '30'),
  ('service_urgent_days',       '7'),
  ('insurance_warning_days',    '30'),
  ('insurance_urgent_days',     '7'),
  ('tax_warning_days',          '30'),
  ('tax_urgent_days',           '7'),
  ('fuel_cost_per_mile_threshold', '0.50'),
  ('notification_roles',        '["admin", "manager"]')
ON CONFLICT (key) DO NOTHING;

-- Grant permissions for backups (same pattern as 009)
GRANT SELECT ON vehicle_mileage_log TO CURRENT_USER;
GRANT SELECT ON vehicle_fuel_log TO CURRENT_USER;
GRANT SELECT ON vehicle_compliance_settings TO CURRENT_USER;
