-- ============================================================================
-- 070: Cost Capture & Recharge — foundation
--
-- Staff-facing cost/receipt capture replacing the Jotform process. A single
-- `costs` entity with optional facets (job, vehicle, freelancer assignment,
-- platform issue, service/fuel log) is the financial spine; `cost_allocations`
-- splits one cost (e.g. a bundled freelancer invoice) across multiple jobs.
--
-- See docs/COST-CAPTURE-RECHARGE-SPEC.md. This migration is the Phase 1
-- foundation — Xero sync, AI extraction, and the frontend land in later PRs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS costs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Capture
  uploaded_by     UUID REFERENCES users(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  supplier_name   VARCHAR(200),
  cost_date       DATE,
  amount_gross    NUMERIC(12,2),
  amount_vat      NUMERIC(12,2),
  amount_net      NUMERIC(12,2),
  currency        VARCHAR(3) NOT NULL DEFAULT 'GBP',
  description     TEXT,
  category        VARCHAR(100),
  xero_account_code VARCHAR(20),

  -- Routing
  cost_type       VARCHAR(30) NOT NULL DEFAULT 'overhead'
    CHECK (cost_type IN ('overhead', 'job', 'vehicle', 'stock', 'parts', 'freelancer_invoice')),
  payment_method  VARCHAR(20)
    CHECK (payment_method IS NULL OR payment_method IN
      ('cot_card', 'petty_cash', 'paypal', 'reimburse_me', 'not_yet_paid', 'other')),
  cot_card_holder VARCHAR(120),
  cot_card_last4  VARCHAR(4),
  payment_status  VARCHAR(20) NOT NULL DEFAULT 'paid'
    CHECK (payment_status IN ('paid', 'awaiting_payment', 'awaiting_invoice')),

  -- Facets
  job_id                 UUID REFERENCES jobs(id),
  vehicle_id             UUID REFERENCES fleet_vehicles(id),
  quote_assignment_id    UUID REFERENCES quote_assignments(id),
  platform_issue_id      UUID REFERENCES platform_issues(id),
  vehicle_service_log_id UUID REFERENCES vehicle_service_log(id),
  vehicle_fuel_log_id    UUID REFERENCES vehicle_fuel_log(id),

  -- Recharge
  recharge_mode       VARCHAR(10) NOT NULL DEFAULT 'none'
    CHECK (recharge_mode IN ('none', 'full', 'partial')),
  recharge_amount     NUMERIC(12,2),
  recharged_to_hh_at  TIMESTAMPTZ,
  recharge_hh_item_id VARCHAR(40),

  -- Approval (payables)
  approval_state  VARCHAR(20)
    CHECK (approval_state IS NULL OR approval_state IN ('submitted', 'verified', 'approved', 'paid')),
  verified_by     UUID REFERENCES users(id),
  verified_at     TIMESTAMPTZ,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  paid_by         UUID REFERENCES users(id),
  paid_at         TIMESTAMPTZ,
  paid_method     VARCHAR(40),

  -- Receipt
  receipt_r2_key   VARCHAR(500),
  receipt_filename VARCHAR(200),

  -- Xero
  xero_sync_state  VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (xero_sync_state IN ('pending', 'bill_created', 'attached', 'reconciled', 'error')),
  xero_object_id   VARCHAR(60),
  xero_synced_at   TIMESTAMPTZ,
  xero_error       TEXT,

  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'confirmed', 'resolved')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bundled-invoice allocations: one cost split across many jobs/assignments.
CREATE TABLE IF NOT EXISTS cost_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id             UUID NOT NULL REFERENCES costs(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES jobs(id),
  quote_assignment_id UUID REFERENCES quote_assignments(id),
  amount              NUMERIC(12,2) NOT NULL,
  recharge            BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costs_job      ON costs (job_id)       WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_vehicle  ON costs (vehicle_id)   WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_issue    ON costs (platform_issue_id) WHERE platform_issue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_payable  ON costs (payment_status, cost_date DESC) WHERE payment_status <> 'paid';
CREATE INDEX IF NOT EXISTS idx_costs_recharge ON costs (recharge_mode)  WHERE recharge_mode <> 'none';
CREATE INDEX IF NOT EXISTS idx_costs_status   ON costs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_allocations_cost ON cost_allocations (cost_id);
CREATE INDEX IF NOT EXISTS idx_cost_allocations_job  ON cost_allocations (job_id) WHERE job_id IS NOT NULL;

-- Bump updated_at on row update.
CREATE OR REPLACE FUNCTION costs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_costs_updated_at ON costs;
CREATE TRIGGER trg_costs_updated_at
  BEFORE UPDATE ON costs
  FOR EACH ROW EXECUTE FUNCTION costs_touch_updated_at();
