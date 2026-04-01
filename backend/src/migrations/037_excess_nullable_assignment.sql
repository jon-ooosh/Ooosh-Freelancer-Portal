-- Migration 037: Make job_excess.assignment_id nullable
-- Allows excess records to be created directly from the Money tab
-- without requiring a hire form / vehicle_hire_assignment first.
-- Excess can now be tracked at the job level, linked to a client entity.

-- Drop the NOT NULL constraint on assignment_id
ALTER TABLE job_excess ALTER COLUMN assignment_id DROP NOT NULL;

-- Must DROP first because COALESCE changes the column type width
-- (varchar(100) → varchar), and CREATE OR REPLACE doesn't allow type changes
DROP VIEW IF EXISTS client_excess_ledger;

-- Recreate view to include records without xero_contact_id
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
  COUNT(*) FILTER (WHERE excess_status = 'pending') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count,
  COUNT(*) FILTER (WHERE dispatch_override = true) AS override_count
FROM job_excess
WHERE excess_status != 'not_required'
GROUP BY COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100);
