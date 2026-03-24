-- Fix audit_log action column: remove restrictive CHECK constraint
-- The original CHECK only allowed 'create', 'update', 'delete' but we need
-- additional actions like 'resolve_referral', 'merge', etc.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ALTER COLUMN action TYPE VARCHAR(50);

-- Restore hire-form-created assignments that were incorrectly cancelled
-- by the compat layer. These have driver_id set (hire forms always set a driver)
-- and were cancelled recently.
UPDATE vehicle_hire_assignments
SET status = 'confirmed', status_changed_at = NOW(), updated_at = NOW()
WHERE status = 'cancelled'
  AND driver_id IS NOT NULL
  AND status_changed_at > NOW() - INTERVAL '7 days';
