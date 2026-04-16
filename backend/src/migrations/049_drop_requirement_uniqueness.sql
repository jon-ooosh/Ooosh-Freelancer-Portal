-- Migration 049: Drop unique constraints on job_requirements to allow multiple reminders/custom per job
-- Uniqueness for non-reminder/non-custom types is enforced in application logic (requirements.ts).
--
-- Migration 021 created: unique_requirement_per_job UNIQUE (job_id, requirement_type)
-- Migration 042 replaced it with: unique_requirement_per_job_phase UNIQUE (job_id, requirement_type, phase)
-- Both must be dropped.

ALTER TABLE job_requirements DROP CONSTRAINT IF EXISTS unique_requirement_per_job;
ALTER TABLE job_requirements DROP CONSTRAINT IF EXISTS unique_requirement_per_job_phase;
