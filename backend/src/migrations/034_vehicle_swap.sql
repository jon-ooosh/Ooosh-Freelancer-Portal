-- Migration 034: Vehicle swap fields on vehicle_hire_assignments
-- Supports mid-hire vehicle swaps (e.g. breakdown → replacement vehicle).
-- Original assignment gets status 'swapped', new assignment is created for replacement.

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS swap_reason TEXT,
  ADD COLUMN IF NOT EXISTS swapped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS swapped_to_assignment_id UUID REFERENCES vehicle_hire_assignments(id);

-- Also add 'swapped' to the status check if one exists
-- (status is currently free text, no CHECK constraint — so no alteration needed)
