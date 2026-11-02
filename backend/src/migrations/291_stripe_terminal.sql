-- 291: Stripe Terminal — in-person card payments on the S700 (docs/STRIPE-TERMINAL-SPEC.md).
--
-- One row per payment sent to a reader. The row is the audit trail (who, which
-- reader, when, what) and the idempotency gate: recording the payment flips
-- status pending|failed → recording in ONE statement, so a webhook, its
-- re-delivery and the modal's "Check status" can never record it twice.
--
-- livemode says which Stripe key the PaymentIntent belongs to: test-mode
-- sessions are driven by STRIPE_TEST_SECRET_KEY against a simulated reader.

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             UUID REFERENCES jobs(id) ON DELETE SET NULL,
  livemode           BOOLEAN NOT NULL,
  reader_id          VARCHAR(100) NOT NULL,
  reader_label       VARCHAR(255),
  payment_intent_id  VARCHAR(255) NOT NULL UNIQUE,
  payment_type       VARCHAR(30) NOT NULL,          -- deposit | balance (hire payments, Phase 1)
  amount             DECIMAL(10,2) NOT NULL,
  notes              TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending       = on the reader, waiting for the card
    -- failed        = declined / reader error; Try again re-sends the SAME PaymentIntent
    -- recording     = card approved, OP is recording it (claimed — nobody else may)
    -- succeeded     = recorded in OP (job_payment_id set)
    -- record_failed = card approved but recording threw — money taken, record by hand
    -- cancelled     = cancelled before a card was taken
  failure_code       VARCHAR(100),
  failure_message    TEXT,
  hh_push_error      TEXT,
  job_payment_id     UUID REFERENCES job_payments(id) ON DELETE SET NULL,
  started_by         UUID REFERENCES users(id),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminal_sessions_job ON terminal_sessions(job_id, started_at DESC);

-- 'test' drives the simulated reader on the test key; 'live' the real S700.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('stripe_terminal_mode', 'test',
        'Card reader mode: test (simulated reader, test key) or live (the real S700)',
        'money', 'text', 60)
ON CONFLICT (key) DO NOTHING;

-- Who sees "Card reader" on Record Payment. Admin only while testing (jon, 16 Oct 2026);
-- widen to e.g. 'admin,manager,staff,general_assistant' once live payments run cleanly.
-- Temporary by design — spec §8 Phase 4 removes the switch.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('stripe_terminal_roles', 'admin',
        'Roles that can take a card payment on the reader (comma-separated)',
        'money', 'text', 61)
ON CONFLICT (key) DO NOTHING;
