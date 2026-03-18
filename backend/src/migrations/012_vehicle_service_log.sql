-- Migration 012: Vehicle Service Log — service and repair history per vehicle
--
-- Previously: Subitems on Monday.com Fleet Management board
-- Now: Structured service/repair records linked to fleet_vehicles

CREATE TABLE IF NOT EXISTS vehicle_service_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id        UUID NOT NULL REFERENCES fleet_vehicles(id) ON DELETE CASCADE,

  -- Core fields (from Monday subitems)
  name              VARCHAR(500) NOT NULL,             -- Description: "1ST SERVICE A", "Repair lower panel"
  service_type      VARCHAR(50) NOT NULL DEFAULT 'service',  -- service, repair
  service_date      DATE,                              -- When the work was done
  mileage           INTEGER,                           -- Odometer at time of service
  cost              DECIMAL(10,2),                     -- Cost of the work
  status            VARCHAR(50),                       -- From Monday: Done, Pending, etc.
  garage            VARCHAR(255),                      -- Garage/bodyshop name
  hirehop_job       VARCHAR(50),                       -- HireHop job number reference
  notes             TEXT,                              -- Free-text notes

  -- Metadata
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_service_log_vehicle ON vehicle_service_log (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_service_log_date ON vehicle_service_log (service_date DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_service_log_type ON vehicle_service_log (service_type);
