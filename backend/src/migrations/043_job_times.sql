-- Migration 043: Add out_time / return_time fields to jobs
-- These are user-set times for when equipment/vehicles actually depart and are expected back.
-- Separate from the TIMESTAMPTZ date columns which come from HireHop sync.
-- Default 09:00 matches the standard hire window.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS out_time TIME DEFAULT '09:00';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS return_time TIME DEFAULT '09:00';

-- For single-day hires (rehearsals etc), an end_time is useful
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS end_time TIME;

COMMENT ON COLUMN jobs.out_time IS 'Time equipment/vehicles depart. Default 09:00. User-editable.';
COMMENT ON COLUMN jobs.return_time IS 'Time equipment expected back. Default 09:00. User-editable.';
COMMENT ON COLUMN jobs.end_time IS 'End time for single-day hires (e.g. rehearsals finish at 6pm). NULL for multi-day.';
