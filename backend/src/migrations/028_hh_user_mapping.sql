-- Migration 028: Add HireHop user ID mapping to users table
-- Allows OP to set the correct "manager" when creating HireHop jobs

ALTER TABLE users ADD COLUMN IF NOT EXISTS hh_user_id INTEGER;

COMMENT ON COLUMN users.hh_user_id IS 'HireHop user ID — used to set job manager when pushing to HireHop';
