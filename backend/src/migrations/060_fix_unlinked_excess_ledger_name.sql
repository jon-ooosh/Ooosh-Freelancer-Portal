-- Migration 060: Fix misleading client name on the UNLINKED group in client_excess_ledger
--
-- The view groups job_excess records by xero_contact_id, defaulting NULL → 'UNLINKED'.
-- The display name was COALESCE(MAX(xero_contact_name), MAX(client_name), 'Unlinked Records').
-- Problem: when many records have no xero_contact_id (typical for derivation-engine
-- auto-creates), they all collapse into the UNLINKED group. MAX(client_name) then
-- alphabetically picks one client name (e.g. "Zal Jones" because Z is high) and
-- mislabels every record in the group under that name on the summary table.
--
-- Fix: when the grouping key is 'UNLINKED' (i.e. xero_contact_id IS NULL), force the
-- display name to 'Unlinked Records' regardless of what client_name values happen to
-- exist on the underlying records. The drill-in detail page still shows each record's
-- real client_name, so no information is lost — just no longer misattributed.
--
-- Followup tracked in CLAUDE.md: properly populate xero_contact_id on derivation-engine
-- creates so unlinked records become a small minority instead of the bulk of the data.

DROP VIEW IF EXISTS client_excess_ledger;

CREATE VIEW client_excess_ledger AS
SELECT
  COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100) AS xero_contact_id,
  CASE
    WHEN COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100) = 'UNLINKED'
      THEN 'Unlinked Records'
    ELSE COALESCE(MAX(xero_contact_name), MAX(client_name), 'Unnamed Client')
  END AS xero_contact_name,
  CASE
    WHEN COALESCE(xero_contact_id, 'UNLINKED')::VARCHAR(100) = 'UNLINKED'
      THEN NULL
    ELSE MAX(client_name)
  END AS client_name,
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

-- Restore SELECT grant for the backup user (DROP VIEW removed it)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON client_excess_ledger TO ooosh_backup;
  END IF;
END $$;
