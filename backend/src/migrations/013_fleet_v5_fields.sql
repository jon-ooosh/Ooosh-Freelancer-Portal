-- Migration 013: Add V5/VE103B fields to fleet_vehicles
--
-- These fields from the V5 document are needed for VE103B certificate generation
-- and vehicle compliance tracking.

ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS vin VARCHAR(50);                -- E: VIN / Chassis number
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS date_first_reg DATE;            -- B: Date of first registration
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS v5_type VARCHAR(200);           -- D.2: Type designation
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS body_type VARCHAR(100);         -- D.5: Body type (e.g. PANEL VAN, MOTOR CARAVAN)
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS max_mass_kg INTEGER;            -- F.1: Maximum permissible mass (kg)
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS vehicle_category VARCHAR(50);   -- J: Vehicle category (e.g. M1, N1)
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS cylinder_capacity_cc INTEGER;   -- P.1: Cylinder capacity (cc)
