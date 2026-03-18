-- Migration 023: User profile enhancements
-- Adds avatar support, password change tracking, and force-password-change flag

-- Avatar URL on users table (R2 key for profile photo)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Force password change flag (admin can require user to change password on next login)
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false;

-- Track when password was last changed
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Allow avatars/ prefix in file downloads
-- (handled in application code, no DB change needed)
