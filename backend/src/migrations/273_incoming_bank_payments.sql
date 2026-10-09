-- 273_incoming_bank_payments.sql
-- Incoming bank transfers noticed from Wise's "Money received from …" emails
-- (services/wise-incoming.ts). One row per Wise email, keyed on the RFC822
-- Message-ID so a re-ingest can never double-record a payment.
--
-- status:
--   unmatched  → needs a human: shown on the Money overview + emailed to info@
--   recorded   → recorded on a job through services/record-payment.ts
--   ignored    → not a job payment (own transfer in, supplier refund, …) — kept for the record
--
-- `amount` is what the client SENT ("Amount received" in the email) — jon's rule,
-- Oct 2026: Xero handles the fee side, so the fee-netted figure is informational.

CREATE TABLE IF NOT EXISTS incoming_bank_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            VARCHAR(30) NOT NULL DEFAULT 'wise_email',
  gmail_message_id  TEXT NOT NULL UNIQUE,
  mailbox           TEXT,
  received_at       TIMESTAMPTZ NOT NULL,
  payer_name        TEXT,
  amount            NUMERIC(12,2) NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'GBP',
  fee               NUMERIC(12,2),
  amount_credited   NUMERIC(12,2),
  reference         TEXT,
  transfer_number   TEXT,
  email_subject     TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'unmatched'
                      CHECK (status IN ('unmatched', 'recorded', 'ignored')),
  match_method      TEXT,
  match_notes       TEXT,
  candidates        JSONB NOT NULL DEFAULT '[]'::jsonb,
  matched_job_id    UUID REFERENCES jobs(id) ON DELETE SET NULL,
  payment_type      VARCHAR(20),
  job_payment_id    UUID REFERENCES job_payments(id) ON DELETE SET NULL,
  hh_deposit_id     INTEGER,
  hh_push_error     TEXT,
  resolved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  alert_sent_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incoming_bank_payments_status
  ON incoming_bank_payments (status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_incoming_bank_payments_job
  ON incoming_bank_payments (matched_job_id);
