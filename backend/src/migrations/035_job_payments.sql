-- Migration 035: Job payments table + organisation payment terms
-- Unified payment recording for the Money system

-- ── job_payments table ──
-- Records ALL payments against a job from any source (Stripe, bank, card, cash, PayPal).
-- Merged with HireHop deposits to show a single timeline on the Money tab.
CREATE TABLE IF NOT EXISTS job_payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID REFERENCES jobs(id) ON DELETE CASCADE,
  hirehop_job_id        INTEGER,

  -- Payment details
  payment_type          VARCHAR(30) NOT NULL,
    -- 'deposit'      = hire deposit (25%, 50%, 100%)
    -- 'balance'      = remaining balance payment
    -- 'excess'       = insurance excess payment
    -- 'refund'       = refund issued to client
    -- 'excess_refund' = excess reimbursement
    -- 'other'        = miscellaneous
  amount                DECIMAL(10,2) NOT NULL,
  currency              VARCHAR(3) DEFAULT 'GBP',

  -- Method
  payment_method        VARCHAR(30) NOT NULL,
    -- 'stripe'        = via Payment Portal (card)
    -- 'stripe_preauth' = Stripe pre-authorisation hold
    -- 'bank_transfer' = manual bank transfer
    -- 'card_in_office' = card terminal in office
    -- 'cash'          = cash payment
    -- 'paypal'        = PayPal transfer
    -- 'rolled_over'   = applied from client balance on account

  -- References
  payment_reference     VARCHAR(255),                 -- Stripe pi_xxx, bank ref, etc.
  stripe_payment_intent VARCHAR(255),                 -- Full Stripe PaymentIntent ID
  hirehop_deposit_id    INTEGER,                      -- HH deposit ID if created via write-back

  -- Status
  payment_status        VARCHAR(20) NOT NULL DEFAULT 'completed',
    -- 'completed'     = payment received and confirmed
    -- 'pending'       = awaiting confirmation (bank transfer sent but not received)
    -- 'pre_auth'      = pre-authorisation hold (not yet captured)
    -- 'captured'      = pre-auth captured (converted to payment)
    -- 'released'      = pre-auth released (no charge)
    -- 'refunded'      = payment refunded
    -- 'failed'        = payment failed

  -- Source tracking
  source                VARCHAR(30) DEFAULT 'op',
    -- 'op'            = recorded via OP Money tab
    -- 'payment_portal' = received from Payment Portal webhook
    -- 'hirehop'       = synced from HireHop deposit
    -- 'manual'        = recorded manually outside system

  -- Excess linkage (if this payment is for an excess)
  excess_id             UUID REFERENCES job_excess(id) ON DELETE SET NULL,

  -- Client linkage
  xero_contact_id       VARCHAR(100),
  client_name           VARCHAR(200),

  -- Audit
  payment_date          TIMESTAMPTZ DEFAULT NOW(),
  recorded_by           UUID REFERENCES users(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_job_payments_job ON job_payments(job_id);
CREATE INDEX IF NOT EXISTS idx_job_payments_hh_job ON job_payments(hirehop_job_id);
CREATE INDEX IF NOT EXISTS idx_job_payments_type ON job_payments(payment_type);
CREATE INDEX IF NOT EXISTS idx_job_payments_status ON job_payments(payment_status);
CREATE INDEX IF NOT EXISTS idx_job_payments_excess ON job_payments(excess_id);
CREATE INDEX IF NOT EXISTS idx_job_payments_date ON job_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_job_payments_xero ON job_payments(xero_contact_id);

-- ── Payment terms on organisations ──
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(30);
  -- 'standard'     = standard terms (deposit upfront)
  -- 'credit_7'     = 7 day credit
  -- 'credit_14'    = 14 day credit
  -- 'credit_30'    = 30 day credit
  -- 'credit_60'    = 60 day credit
  -- 'no_deposit'   = no deposit required
  -- 'custom'       = custom terms (see notes)

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS payment_terms_notes TEXT;
