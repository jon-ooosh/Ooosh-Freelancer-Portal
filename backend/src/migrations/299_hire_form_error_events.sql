-- Migration 299: errors reported by the driver hire form app
--
-- The hire form (separate Netlify app) reports anything that goes wrong for a
-- driver — an upload that failed, the join-to-hire call failing at signature,
-- a page crash — through its log-client-error function. Until Oct 2026 those
-- went to a Google Apps Script that was meant to log them to a "Health check"
-- sheet and email critical ones to problemcatcher@. Its doPost never handled
-- the 'log-error' action, so nothing was ever logged or emailed.
--
-- Every report is kept here (critical, warning, info — including the session
-- check's "would reject" lines). Only CRITICAL ones email info@, and
-- `alerted` records which did, so the hourly limits can count them.
-- See services/hire-form-errors.ts.

CREATE TABLE IF NOT EXISTS hire_form_error_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity         VARCHAR(10) NOT NULL,
  page             VARCHAR(100) NOT NULL,
  error            TEXT NOT NULL,
  driver_email     VARCHAR(255),
  job_number       VARCHAR(20),
  url              TEXT,
  user_agent       TEXT,
  additional_info  TEXT,
  alerted          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hire_form_error_events_recent
  ON hire_form_error_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hire_form_error_events_alerted
  ON hire_form_error_events (created_at DESC) WHERE alerted;

DO $$ BEGIN
  EXECUTE 'GRANT SELECT ON hire_form_error_events TO backup_user';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role backup_user does not exist, skipping GRANT';
END $$;
