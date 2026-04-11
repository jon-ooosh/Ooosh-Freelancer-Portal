-- Migration 042: Job Requirements Phase System (Pre-Hire / Post-Hire)
--
-- Adds a phase column to job_requirements to support separate pre-hire and
-- post-hire workflow views. Same requirement types can exist in both phases
-- with independent statuses.
--
-- Pre-hire: vehicle prep, backline prep, hire forms, excess, transport
-- Post-hire: backline de-prep, vehicle check-in, damage inspection, etc.

-- Add phase column (defaults to 'pre_hire' for existing requirements)
ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS phase VARCHAR(20) NOT NULL DEFAULT 'pre_hire';

-- Update the unique constraint to allow same requirement type in both phases
-- Drop old constraint first (it was DEFERRABLE so we need to find it)
ALTER TABLE job_requirements
  DROP CONSTRAINT IF EXISTS unique_requirement_per_job;

-- New constraint: unique per job + type + phase
ALTER TABLE job_requirements
  ADD CONSTRAINT unique_requirement_per_job_phase UNIQUE (job_id, requirement_type, phase)
  DEFERRABLE INITIALLY DEFERRED;

-- Index on phase for efficient filtering
CREATE INDEX IF NOT EXISTS idx_job_requirements_phase ON job_requirements(phase);

-- Add post-hire type definitions for warehouse de-prep operations
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('backline_deprep', 'Backline De-Prep', '🔙', NULL, 65)
ON CONFLICT (type) DO NOTHING;
