-- Migration 048: Add event_trigger and delivery_method columns to job_requirements
-- Supports event-triggered reminders (fire notification when job reaches a status)
-- and per-reminder delivery method enforcement (bell only / email only / both)

ALTER TABLE job_requirements ADD COLUMN IF NOT EXISTS event_trigger VARCHAR(30);
-- Values: NULL (date-based only), 'confirmed', 'cancelled', 'lost'

ALTER TABLE job_requirements ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) DEFAULT 'both';
-- Values: 'notification' (bell only), 'email' (email only), 'both'
