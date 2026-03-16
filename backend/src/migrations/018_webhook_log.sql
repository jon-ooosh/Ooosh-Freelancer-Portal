-- Migration 018: Webhook log + API keys for external service auth
-- Tracks inbound webhooks and provides API key auth for external callers

-- ── Webhook event log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(50) NOT NULL,               -- 'hirehop', 'stripe', etc.
  event VARCHAR(100) NOT NULL,               -- e.g. 'job.status.updated'
  payload JSONB,                             -- raw webhook payload
  processed BOOLEAN DEFAULT false,
  processing_result JSONB,                   -- { success, message, changes }
  error TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_source ON webhook_log(source);
CREATE INDEX IF NOT EXISTS idx_webhook_log_event ON webhook_log(event);
CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON webhook_log(received_at DESC);

-- ── API keys for external service authentication ───────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,                -- descriptive name e.g. 'Payment Portal'
  key_hash VARCHAR(255) NOT NULL,            -- bcrypt hash of the API key
  key_prefix VARCHAR(8) NOT NULL,            -- first 8 chars for identification
  service VARCHAR(50) NOT NULL,              -- 'payment_portal', 'staging_calc', etc.
  permissions JSONB DEFAULT '[]'::jsonb,     -- allowed operations
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix) WHERE is_active = true;

-- Grant permissions for backup user
GRANT SELECT, INSERT, UPDATE ON webhook_log TO current_user;
GRANT SELECT, INSERT, UPDATE ON api_keys TO current_user;
