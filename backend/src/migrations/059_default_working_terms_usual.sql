-- Migration 059: Default working_terms_type = 'usual' for existing rows
--
-- Historically working_terms_type was nullable with no default. New rows from
-- April 2026 onwards default to 'usual' at the API layer; this migration
-- backfills the existing NULL rows so every person/org has an explicit value.
--
-- Safety: this is intentionally idempotent and narrow — it only touches rows
-- where working_terms_type IS NULL. Any explicit value (including 'credit' /
-- 'flex_balance' / 'do_not_hire' etc., or whatever the Monday import script
-- has already set) is left alone.

-- People
UPDATE people
   SET working_terms_type = 'usual',
       updated_at = NOW()
 WHERE working_terms_type IS NULL
   AND is_deleted = false;

-- Organisations
UPDATE organisations
   SET working_terms_type = 'usual',
       updated_at = NOW()
 WHERE working_terms_type IS NULL
   AND is_deleted = false;
