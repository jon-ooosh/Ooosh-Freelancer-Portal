-- Migration 302: sign out a freelancer's other portal sessions on a password reset
--
-- A portal session is a 30-day cookie. Until Oct 2026 nothing could end one
-- early: resetting a password (what someone does when they think their login
-- is known) left every existing session working. routes/portal.ts portalAuth
-- now refuses a session issued before this moment; the reset sets it.
-- NULL = no cut-off. (PR 5's "sign out everywhere" will set it too.)

ALTER TABLE people ADD COLUMN IF NOT EXISTS portal_sessions_valid_after TIMESTAMPTZ;
