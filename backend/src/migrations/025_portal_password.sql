-- Migration 025: Add portal authentication fields to people table
-- Supports freelancer portal login via OP backend (replacing Monday.com password storage)

-- Portal password hash (bcryptjs format, migrated from Monday.com)
ALTER TABLE people ADD COLUMN IF NOT EXISTS portal_password_hash TEXT;

-- Portal email verified flag (replaces Monday.com "Email Verified" status column)
ALTER TABLE people ADD COLUMN IF NOT EXISTS portal_email_verified BOOLEAN DEFAULT false;

-- Portal last login timestamp
ALTER TABLE people ADD COLUMN IF NOT EXISTS portal_last_login TIMESTAMPTZ;

-- Index for portal login lookups (email + freelancer flag)
CREATE INDEX IF NOT EXISTS idx_people_portal_login
  ON people (LOWER(email)) WHERE is_freelancer = true;

-- Grant permissions for backup user
GRANT SELECT ON people TO backup_user;
