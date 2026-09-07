-- ============================================================================
-- Driver email verification codes (OTP) — bring the hire-form login code
-- fully in-house (jon, Sep 2026).
--
-- Historically the hire form app's send-verification-code / verify-code Netlify
-- functions generated, stored AND validated the 6-digit OTP inside a Google
-- Apps Script bound to a Google Sheet. This table moves that state into OP so
-- the whole loop — generate, store, email (via the live Resend email service),
-- validate — is owned by the platform and the Apps Script drops out entirely.
--
-- The hire form app's functions become thin proxies to
--   POST /api/driver-verification/send-code
--   POST /api/driver-verification/verify-code
-- (the HMAC session token is still minted in verify-code.js after a successful
-- verify — that's independent of where the code lives).
--
-- See CLAUDE.md (both repos) → hire-form OTP / "do it all in OP".
-- ============================================================================

CREATE TABLE IF NOT EXISTS driver_verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL,          -- lowercased at write time
  code        VARCHAR(6)  NOT NULL,          -- 6-digit numeric OTP
  job_id      TEXT,                          -- optional HH job number for context
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0, -- failed verify attempts (lock after N)
  consumed_at TIMESTAMPTZ,                   -- set on successful verify (single-use)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look up the latest live code for an email (verify + resend-throttle both use this).
CREATE INDEX IF NOT EXISTS idx_driver_verification_codes_email_created
  ON driver_verification_codes (lower(email), created_at DESC);

-- Housekeeping: find expired/consumed rows to prune.
CREATE INDEX IF NOT EXISTS idx_driver_verification_codes_expires
  ON driver_verification_codes (expires_at);
