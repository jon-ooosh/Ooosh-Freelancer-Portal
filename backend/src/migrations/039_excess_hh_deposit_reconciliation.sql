-- Migration 039: Excess ↔ HireHop Deposit Reconciliation
--
-- Adds hh_deposit_id to job_excess so each excess record can be directly
-- linked to its corresponding HireHop deposit. This enables:
-- 1. Passive reconciliation: when Money tab loads, match HH excess deposits to OP records
-- 2. Deduplication: same deposit never shown twice (once in HH billing, once in OP excess)
-- 3. Reimbursement: direct lookup of original deposit for refund applications

-- Direct link from excess record to HH deposit
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS hh_deposit_id INTEGER;

-- When the reconciliation happened (NULL = never reconciled from HH side)
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS hh_reconciled_at TIMESTAMPTZ;

-- Source of the reconciliation (how was this link established)
-- 'op_push' = OP created the deposit and stored the ID
-- 'auto_match' = passive reconciliation matched by keyword on billing_list load
-- 'manual_link' = staff manually linked an HH deposit to this excess record
ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS hh_reconcile_source VARCHAR(20);

-- Index for quick lookup by HH deposit ID (used during reconciliation)
CREATE INDEX IF NOT EXISTS idx_job_excess_hh_deposit_id ON job_excess(hh_deposit_id) WHERE hh_deposit_id IS NOT NULL;

-- Also index job_payments.hirehop_deposit_id if not already indexed
CREATE INDEX IF NOT EXISTS idx_job_payments_hh_deposit_id ON job_payments(hirehop_deposit_id) WHERE hirehop_deposit_id IS NOT NULL;
