-- Migration 022: Standardise roles + add optimistic locking
-- Roles: admin, manager, staff, general_assistant, weekend_manager, freelancer
-- Optimistic locking: adds version column to key tables

-- ============================================================================
-- 1. Standardise user roles
-- ============================================================================

-- First update any existing users with old roles to 'staff'
UPDATE users SET role = 'staff' WHERE role IN ('warehouse', 'driver', 'client');

-- Drop the old CHECK constraint and add the new one
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'manager', 'staff', 'general_assistant', 'weekend_manager', 'freelancer'));

-- ============================================================================
-- 2. Optimistic locking - add version column to key tables
-- ============================================================================

ALTER TABLE people ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

-- ============================================================================
-- 3. Account locking - null refresh token when deactivated
--    (is_active already exists, we just need the trigger)
-- ============================================================================

CREATE OR REPLACE FUNCTION clear_refresh_on_deactivate()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = false AND OLD.is_active = true THEN
    NEW.refresh_token = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clear_refresh_on_deactivate ON users;
CREATE TRIGGER trg_clear_refresh_on_deactivate
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION clear_refresh_on_deactivate();
