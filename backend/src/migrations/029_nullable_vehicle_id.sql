-- Migration 029: Make vehicle_id nullable on vehicle_hire_assignments
-- Vehicle is NOT known at hire form time — drivers fill out forms for a JOB,
-- and vehicles are assigned later by staff on the allocations page.

ALTER TABLE vehicle_hire_assignments ALTER COLUMN vehicle_id DROP NOT NULL;
