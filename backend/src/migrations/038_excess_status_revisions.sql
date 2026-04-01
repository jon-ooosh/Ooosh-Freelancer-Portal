-- Migration 038: Revise excess status names and add new statuses
-- Renames: pending→needed, taken→taken (no change), partial→partially_paid
-- Adds: pre_auth (card hold without charge)
-- Splits: claimed → fully_claimed (keeping full amount) + partially_reimbursed (returning some, claiming rest)

-- Update existing records to new status names
UPDATE job_excess SET excess_status = 'needed' WHERE excess_status = 'pending';
UPDATE job_excess SET excess_status = 'partially_paid' WHERE excess_status = 'partial';
UPDATE job_excess SET excess_status = 'fully_claimed' WHERE excess_status = 'claimed';

-- Update the client_excess_ledger view to use new status names
DROP VIEW IF EXISTS client_excess_ledger;

CREATE VIEW client_excess_ledger AS
SELECT
  COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100) AS xero_contact_id,
  COALESCE(MAX(xero_contact_name), MAX(client_name), 'Unlinked Records') AS xero_contact_name,
  MAX(client_name) AS client_name,
  COUNT(*) AS total_hires,
  COALESCE(SUM(excess_amount_taken), 0) AS total_taken,
  COALESCE(SUM(claim_amount), 0) AS total_claimed,
  COALESCE(SUM(reimbursement_amount), 0) AS total_reimbursed,
  COALESCE(SUM(excess_amount_taken), 0)
    - COALESCE(SUM(claim_amount), 0)
    - COALESCE(SUM(reimbursement_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'needed') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count,
  COUNT(*) FILTER (WHERE dispatch_override = true) AS override_count
FROM job_excess
WHERE excess_status != 'not_required'
GROUP BY COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100);
