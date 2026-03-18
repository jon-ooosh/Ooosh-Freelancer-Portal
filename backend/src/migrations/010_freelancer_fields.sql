-- Migration 010: Freelancer identification fields
-- Adds explicit is_freelancer flag, joined date, review date to people table
-- Previously freelancer status was inferred from skills array being non-empty

-- Add freelancer identification fields
ALTER TABLE people ADD COLUMN IF NOT EXISTS is_freelancer BOOLEAN DEFAULT false;
ALTER TABLE people ADD COLUMN IF NOT EXISTS freelancer_joined_date DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS freelancer_next_review_date DATE;

-- Create index for freelancer queries
CREATE INDEX IF NOT EXISTS idx_people_is_freelancer ON people (is_freelancer) WHERE is_freelancer = true;
CREATE INDEX IF NOT EXISTS idx_people_is_approved ON people (is_approved) WHERE is_approved = true;
CREATE INDEX IF NOT EXISTS idx_people_freelancer_review ON people (freelancer_next_review_date) WHERE freelancer_next_review_date IS NOT NULL;

-- Backfill: anyone with skills populated or is_approved = true is a freelancer
UPDATE people
SET is_freelancer = true
WHERE (skills IS NOT NULL AND array_length(skills, 1) > 0)
   OR is_approved = true;

-- Grant backup user permissions if exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON people TO ooosh_backup;
  END IF;
END $$;
