-- Migration 034: Excess system enhancements
-- Adds dispatch override, suggested collection method, and person/org linkage fields

-- ── Dispatch override fields ──
-- When a manager overrides the excess gate to allow dispatch without collection
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS dispatch_override BOOLEAN DEFAULT false;
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS dispatch_override_reason VARCHAR(200);
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS dispatch_override_by UUID REFERENCES users(id);
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS dispatch_override_at TIMESTAMPTZ;

-- ── Collection method hint ──
-- Driven by hire duration: <=4 days suggests pre-auth (saves card fees), >4 days suggests payment
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS suggested_collection_method VARCHAR(20) DEFAULT 'payment';
  -- 'payment' = standard card/bank/cash collection
  -- 'pre_auth' = card pre-authorisation (no fees, auto-releases)

-- ── Person linkage ──
-- Excess is tied to a person (driver) for address book integration
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES people(id);

-- ── Audit notes ──
-- General notes field for any context (override reasons, special arrangements, etc.)
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS notes TEXT;

-- ── Indexes for new query patterns ──
CREATE INDEX IF NOT EXISTS idx_job_excess_person ON job_excess(person_id);
CREATE INDEX IF NOT EXISTS idx_job_excess_dispatch_override ON job_excess(dispatch_override) WHERE dispatch_override = true;

-- ── Update client_excess_ledger view to include override and person data ──
CREATE OR REPLACE VIEW client_excess_ledger AS
SELECT
  xero_contact_id,
  MAX(xero_contact_name) AS xero_contact_name,
  MAX(client_name) AS client_name,
  COUNT(*) AS total_hires,
  COALESCE(SUM(excess_amount_taken), 0) AS total_taken,
  COALESCE(SUM(claim_amount), 0) AS total_claimed,
  COALESCE(SUM(reimbursement_amount), 0) AS total_reimbursed,
  COALESCE(SUM(excess_amount_taken), 0)
    - COALESCE(SUM(claim_amount), 0)
    - COALESCE(SUM(reimbursement_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'pending') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count,
  COUNT(*) FILTER (WHERE dispatch_override = true) AS override_count
FROM job_excess
WHERE excess_status != 'not_required'
  AND xero_contact_id IS NOT NULL
GROUP BY xero_contact_id;
