-- Migration 055: Hire form app Monday-fallback telemetry
--
-- When the standalone hire form app (Netlify) calls an OP endpoint and the
-- call fails, op-backend.js is expected to fall back to Monday.com so the
-- driver flow isn't blocked. We don't want silent fallbacks — every one is
-- recorded here, and the first event per operation per hour also fires an
-- admin inbox notification + email to info@oooshtours.co.uk.
--
-- Mirrors portal_fallback_events (migration 052). Separate table so the two
-- audit trails don't get muddled.

CREATE TABLE IF NOT EXISTS hire_form_fallback_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation       VARCHAR(50) NOT NULL,
  error_message   TEXT,
  email           VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hire_form_fallback_recent
  ON hire_form_fallback_events (operation, created_at DESC);

DO $$ BEGIN
  EXECUTE 'GRANT SELECT ON hire_form_fallback_events TO backup_user';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role backup_user does not exist, skipping GRANT';
END $$;
