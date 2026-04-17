-- Migration 052: Portal auth (verification + reset) + completion chase tracking
-- Supports freelancer portal self-serve registration, forgot-password flow,
-- and reminder scheduler for overdue job completions.

-- ── Portal verification codes (email OTP during registration) ─────────
CREATE TABLE IF NOT EXISTS portal_verification_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL,
  code            VARCHAR(12) NOT NULL,     -- 6-digit OTP, zero-padded
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,              -- single-use marker
  attempts        INTEGER DEFAULT 0,        -- anti-brute-force
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_verification_email
  ON portal_verification_codes (LOWER(email), expires_at DESC);

-- ── Portal password reset tokens (single-use, 1h TTL) ─────────────────
CREATE TABLE IF NOT EXISTS portal_password_reset_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  token_hash      VARCHAR(255) NOT NULL,    -- SHA-256 of the raw token (don't store plaintext)
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  ip_address      INET
);

CREATE INDEX IF NOT EXISTS idx_portal_reset_token_hash
  ON portal_password_reset_tokens (token_hash) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_reset_person
  ON portal_password_reset_tokens (person_id, created_at DESC);

-- ── Completion chase tracking on quotes ───────────────────────────────
-- 0 = not chased, 1 = first reminder sent, 2 = second, 3 = third (staff escalated)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completion_reminder_level INTEGER DEFAULT 0;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS completion_last_reminder_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_quotes_completion_chase
  ON quotes (ops_status, job_date, completion_reminder_level)
  WHERE ops_status NOT IN ('completed', 'cancelled');

-- ── Portal fallback telemetry dedup (in-memory alternative kept elsewhere; this is belt-and-braces) ──
CREATE TABLE IF NOT EXISTS portal_fallback_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation       VARCHAR(50) NOT NULL,
  error_message   TEXT,
  email           VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_fallback_recent
  ON portal_fallback_events (operation, created_at DESC);

-- Grant permissions for backup user if role exists
DO $$ BEGIN
  EXECUTE 'GRANT SELECT ON portal_verification_codes, portal_password_reset_tokens, portal_fallback_events TO backup_user';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role backup_user does not exist, skipping GRANT';
END $$;
