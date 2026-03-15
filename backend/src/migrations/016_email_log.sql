-- Migration 016: Email audit log table
-- Tracks all outbound emails sent by the email service.

CREATE TABLE IF NOT EXISTS email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR(100) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  actual_recipient VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  message_id VARCHAR(500),
  error_message TEXT,
  mode VARCHAR(10) NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying by recipient or template
CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log (recipient);
CREATE INDEX IF NOT EXISTS idx_email_log_template ON email_log (template_id);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log (created_at DESC);

-- Grant permissions for backup user (consistent with migration 009)
GRANT SELECT ON email_log TO PUBLIC;
