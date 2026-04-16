-- Migration 050: Drop the phase-aware unique constraint from migration 042
-- Migration 049 dropped the original constraint (unique_requirement_per_job) but missed
-- the replacement created by migration 042 (unique_requirement_per_job_phase).
-- Uniqueness is enforced in application logic, exempting 'reminder' and 'custom' types.

ALTER TABLE job_requirements DROP CONSTRAINT IF EXISTS unique_requirement_per_job_phase;
