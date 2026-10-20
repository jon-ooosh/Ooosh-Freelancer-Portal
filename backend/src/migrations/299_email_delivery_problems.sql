-- ============================================================================
-- Email delivery problems — hearing back from Resend (Oct 2026).
--
-- Until now OP handed each email to Resend, Resend said "accepted", and
-- email_log wrote 'sent'. What happened next — delivered, bounced, blocked
-- because the address is on Resend's suppression list, reported as spam —
-- never came back, so a client could miss a booking confirmation or a hire
-- form with OP's record saying it went. Found by eye in the Resend dashboard
-- (job 16893: a CC address that had hard-bounced was being suppressed on
-- every email; a booking confirmation to another client had bounced too).
--
-- Resend now calls POST /api/webhooks/resend (services/email-delivery.ts).
--
-- 1. email_log.job_number — the HireHop job number the email was about,
--    captured at send time (template variable `jobNumber`, else a "#NNNNN" in
--    the subject). Lets a failure link back to its job. NULL for non-job mail.
--
-- 2. email_delivery_events — one row per recipient per bad event Resend tells
--    us about. UNIQUE (webhook_id, recipient) makes Resend's retries no-ops.
--    `alerted` records whether this one raised the bell + info@ email (they
--    are deduped per address per job per 24h).
--
-- 3. email_address_problems — ONE row per address (lower-cased). Open while
--    resolved_at IS NULL: the address shows a warning in OP. It clears itself
--    when a later email to the address is delivered, or a person clears it
--    ("Mark as fixed"). A new failure re-opens it.
-- ============================================================================

ALTER TABLE email_log ADD COLUMN IF NOT EXISTS job_number INTEGER;
CREATE INDEX IF NOT EXISTS idx_email_log_message_id ON email_log (message_id);

CREATE TABLE IF NOT EXISTS email_delivery_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id        VARCHAR(100) NOT NULL,   -- svix-id header; the same on a retry
  event_type        VARCHAR(20) NOT NULL
                    CHECK (event_type IN ('bounced', 'suppressed', 'complained', 'failed')),
  provider_email_id VARCHAR(100),            -- Resend's email id (= email_log.message_id)
  recipient         VARCHAR(320) NOT NULL,   -- lower-cased
  subject           VARCHAR(500),
  detail            TEXT,                    -- Resend's reason, as given
  email_log_id      UUID REFERENCES email_log(id) ON DELETE SET NULL,
  template_id       VARCHAR(100),
  job_id            UUID REFERENCES jobs(id) ON DELETE SET NULL,
  alerted           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (webhook_id, recipient)
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recipient
  ON email_delivery_events (recipient, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_job
  ON email_delivery_events (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_address_problems (
  email          VARCHAR(320) PRIMARY KEY,  -- lower-cased, trimmed
  problem        VARCHAR(20) NOT NULL
                 CHECK (problem IN ('bounced', 'suppressed', 'complained')),
  detail         TEXT,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this spell opened
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failed_count   INTEGER NOT NULL DEFAULT 1,          -- failures in this spell
  resolved_at    TIMESTAMPTZ,
  resolved_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_how   VARCHAR(20) CHECK (resolved_how IN ('delivered', 'marked_fixed')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON email_delivery_events TO ooosh_backup;
    GRANT SELECT ON email_address_problems TO ooosh_backup;
  END IF;
END $$;
