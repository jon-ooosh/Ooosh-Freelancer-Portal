-- Migration 049: Drop unique constraint on job_requirements to allow multiple reminders/custom per job
-- The UNIQUE (job_id, requirement_type) constraint prevents creating multiple reminders
-- or custom requirements on the same job. Uniqueness for other types is enforced in
-- application logic (requirements.ts), which already exempts 'reminder' and 'custom' types.

ALTER TABLE job_requirements DROP CONSTRAINT IF EXISTS unique_requirement_per_job;
