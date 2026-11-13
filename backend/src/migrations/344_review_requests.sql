-- 344: Jon's review request email (docs/BUSINESS-FIGURES-SPEC.md §8c).
--
-- The day after a hire is Completed, a personal email from Jon asks the client for
-- a Google review. One row per job records what happened: sent, skipped by staff
-- ("don't send" on the job), or not sent and why (completed more than ten days after
-- the return, no client email, asked within the last year, asked never to be asked).
-- A row is written BEFORE the email goes, so a failure never sends twice.

CREATE TABLE IF NOT EXISTS review_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status      VARCHAR(20) NOT NULL CHECK (status IN ('skipped', 'sent', 'not_sent')),
  reason      VARCHAR(300),          -- why not sent / skipped
  sent_to     VARCHAR(320),          -- the address it went to (lower case)
  client_id   UUID,                  -- the job's client org when it was sent (once a year per client)
  sent_at     TIMESTAMPTZ,
  decided_by  UUID REFERENCES users(id),  -- who ticked "don't send"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_review_requests_sent_to ON review_requests (sent_to) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_review_requests_client ON review_requests (client_id) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_review_requests_created ON review_requests (created_at DESC);

-- "Don't ask me again" — by email address (lower case), from the link in the email.
CREATE TABLE IF NOT EXISTS review_request_optouts (
  email       VARCHAR(320) PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Off until jon turns it on (Marketing › Review emails). Production sends every
-- template for real, so the switch is the only thing standing between a deploy and
-- clients' inboxes.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('review_requests_enabled', 'false',
        'Send Jon''s review request email the day after a hire is completed (Marketing › Review emails)',
        'marketing', 'bool', 60)
ON CONFLICT (key) DO NOTHING;
