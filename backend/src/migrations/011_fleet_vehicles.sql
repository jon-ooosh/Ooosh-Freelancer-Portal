-- Migration 011: Fleet Vehicles — full vehicle fleet table (replaces Monday.com Fleet Master board)
--
-- Previously: Vehicle data lived on Monday.com board #4255233576
-- Now: All fleet data lives in the OP's PostgreSQL database
--
-- The existing `vehicles` table (from 007_calculator.sql) was never created —
-- only calculator_settings and quotes were. This creates the fleet table fresh.

CREATE TABLE IF NOT EXISTS fleet_vehicles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Registration & identity
  reg               VARCHAR(20) NOT NULL UNIQUE,      -- Vehicle registration plate (e.g. "RO71JYA")
  vehicle_type      VARCHAR(100),                      -- Full type: "PREMIUM LWB (A)", "BASIC MWB (M)"
  simple_type       VARCHAR(50),                       -- Premium, Basic, Panel, Vito
  make              VARCHAR(100),                      -- MERCEDES-BENZ, VOLKSWAGEN, FORD
  model             VARCHAR(200),                      -- SPRINTER 317 PREMIUM CDI, etc.
  colour            VARCHAR(50),                       -- BLUE, SILVER, WHITE, GREY
  seats             SMALLINT,                          -- 3, 6, 9

  -- Status fields
  damage_status     VARCHAR(50) DEFAULT 'ALL GOOD',    -- ALL GOOD, BOOK REPAIR!, QUOTE NEEDED, REPAIR BOOKED
  service_status    VARCHAR(50) DEFAULT 'OK',          -- OK, SERVICE BOOKED, SERVICE DUE!, SERVICE DUE SOON, CHECK
  hire_status       VARCHAR(50) DEFAULT 'Available',   -- Available, On Hire, Collected, Prep Needed, Not Ready

  -- Key dates
  mot_due           DATE,
  tax_due           DATE,
  tfl_due           DATE,                              -- TfL 9-seater compliance expiry
  last_service_date DATE,
  warranty_expires  DATE,

  -- Mileage & service
  last_service_mileage INTEGER,
  next_service_due     INTEGER,                        -- Mileage-based threshold

  -- Compliance & features
  ulez_compliant    BOOLEAN DEFAULT true,
  spare_key         BOOLEAN DEFAULT false,
  wifi_network      VARCHAR(50),                       -- EE, Vodafone, THREE, N/A

  -- Finance
  finance_with      VARCHAR(100),                      -- Finance company name
  finance_ends      DATE,                              -- Finance agreement end date

  -- Emissions & tyres
  co2_per_km        DECIMAL(8,2),                      -- g/km for carbon offset calculations
  recommended_tyre_psi_front DECIMAL(5,1),
  recommended_tyre_psi_rear  DECIMAL(5,1),

  -- Fuel data (used by transport calculator)
  fuel_type         VARCHAR(20) DEFAULT 'diesel',      -- diesel, petrol, electric, hybrid
  mpg               DECIMAL(6,2),                      -- Miles per gallon

  -- Fleet grouping
  fleet_group       VARCHAR(50) DEFAULT 'active',      -- active, old_sold, new_staging
  is_active         BOOLEAN DEFAULT true,              -- false = old/sold/decommissioned

  -- Monday.com migration reference (temporary, for data import)
  monday_item_id    VARCHAR(50),                       -- Monday.com item ID (for one-time import mapping)

  -- Metadata
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_reg ON fleet_vehicles (reg);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_simple_type ON fleet_vehicles (simple_type);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_hire_status ON fleet_vehicles (hire_status);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_active ON fleet_vehicles (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_fleet_group ON fleet_vehicles (fleet_group);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_fleet_vehicles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fleet_vehicles_updated_at ON fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_updated_at
  BEFORE UPDATE ON fleet_vehicles
  FOR EACH ROW
  EXECUTE FUNCTION update_fleet_vehicles_updated_at();
