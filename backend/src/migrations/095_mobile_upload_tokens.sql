-- 095_mobile_upload_tokens.sql
-- Mobile upload handoff tokens (PR 3 follow-up, May 2026)
--
-- Lets a staff member on a laptop hand off a file capture to their phone: the
-- laptop mints a short-lived token, renders it as a QR code; the phone scans it,
-- opens a public page authenticated SOLELY by the token (no login), captures a
-- photo and uploads it. The token is scoped to a single purpose + target so it
-- can't be used for anything else.
--
-- First consumer: excess card-machine receipt scans (purpose='excess_receipt',
-- target_id = job_excess.id). Built reusable so book-out/check-in walkaround
-- handoff (long flagged in CLAUDE.md) can adopt the same table later.
--
-- Lifecycle: created → (phone redeems) consumed. Expires after a short TTL.
-- resolve treats expired OR consumed tokens as no-longer-valid for upload.

BEGIN;

CREATE TABLE IF NOT EXISTS mobile_upload_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE,
  purpose     VARCHAR(50) NOT NULL,            -- 'excess_receipt' (extensible)
  target_id   UUID NOT NULL,                   -- e.g. job_excess.id
  created_by  UUID REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,                      -- set when the phone completes the upload
  result_key  TEXT,                             -- R2 key of the uploaded file
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mobile_upload_tokens_token ON mobile_upload_tokens(token);

COMMIT;
