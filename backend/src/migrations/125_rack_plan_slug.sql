-- 125_rack_plan_slug.sql
--
-- Short, eyeball-friendly slug for the view-only URL (/rack/<slug>), mirroring
-- the Staging Calculator's short links. The long view_token still resolves too
-- (backward compat), so existing links keep working.

ALTER TABLE rack_plans ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill existing rows with a short random slug (12 hex chars).
UPDATE rack_plans SET slug = encode(gen_random_bytes(6), 'hex') WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rack_plans_slug ON rack_plans(slug);
