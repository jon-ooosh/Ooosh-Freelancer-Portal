-- 109_canonical_excess_held.sql
--
-- ONE SOURCE OF TRUTH for "excess actually held" across the whole site.
--
-- Problem: three surfaces computed "held" three different ways, so they
-- disagreed and the ledger over-stated:
--   - /money/excess (client_excess_ledger view): SUM(excess_amount_taken)
--     − claims − reimbursements over everything except not_required. This
--     COUNTED rolled_over records — a rolled-forward £1,200 sits on BOTH the
--     old (rolled_over) record and the new record, so it was counted twice.
--     It also ignored pre-auth holds (amount_held).
--   - /money/overview card: taken+held for taken/partially_paid/pre_auth
--     (missed partially_reimbursed residual; didn't subtract claims).
--   - dashboard "unreimbursed" bucket: taken/partially_paid, finished 5d+.
--
-- Fix: a single per-record view, v_excess_held, defining the canonical
-- "held_amount" for each record. Every surface sums from it. NOTE: this only
-- changes how records are AGGREGATED for display — the excess lifecycle
-- (collection / claim / reimburse / rollover / pre-auth capture+release) is
-- untouched. Reversible (it's just view definitions).
--
-- Canonical per-record held:
--   held = max(amount_taken + amount_held − claim_amount − reimbursement_amount, 0)
--   for records NOT IN (rolled_over, released, not_required)
-- Why those exclusions:
--   - rolled_over: the cash moved to the forward record (counts there).
--   - released:    pre-auth hold ended, nothing kept.
--   - not_required: top-N loser, £0 by definition.
-- reimbursed / fully_claimed records net to 0 naturally (taken − reimburse/claim).

CREATE OR REPLACE VIEW v_excess_held AS
SELECT
  je.id              AS excess_id,
  je.job_id,
  je.xero_contact_id,
  je.client_name,
  je.excess_status,
  GREATEST(
    COALESCE(je.excess_amount_taken, 0) + COALESCE(je.amount_held, 0)
    - COALESCE(je.claim_amount, 0) - COALESCE(je.reimbursement_amount, 0),
    0
  ) AS held_amount
FROM job_excess je
WHERE je.excess_status NOT IN ('rolled_over', 'released', 'not_required');

-- Redefine the client ledger to take balance_held from v_excess_held (single
-- source). Everything else — grouping key (migration 063), the lifetime
-- total_taken/claimed/reimbursed breakdown columns, and the counts — is
-- preserved exactly so the /money/excess page and ledger drill-in are unchanged
-- in shape. Only balance_held's VALUE is corrected.

DROP VIEW IF EXISTS client_excess_ledger;

CREATE VIEW client_excess_ledger AS
WITH base AS (
  SELECT
    CASE
      WHEN je.xero_contact_id IS NOT NULL AND je.xero_contact_id <> '' THEN je.xero_contact_id
      WHEN je.client_name IS NOT NULL AND je.client_name <> '' THEN 'name:' || je.client_name
      ELSE 'UNLINKED'
    END AS group_key,
    je.*,
    COALESCE(h.held_amount, 0) AS held_amount
  FROM job_excess je
  LEFT JOIN v_excess_held h ON h.excess_id = je.id
  WHERE je.excess_status != 'not_required'
)
SELECT
  group_key::VARCHAR(200) AS xero_contact_id,
  CASE
    WHEN group_key = 'UNLINKED' THEN 'Unlinked Records'
    WHEN group_key LIKE 'name:%' THEN SUBSTRING(group_key FROM 6)
    ELSE COALESCE(MAX(xero_contact_name), MAX(client_name), 'Unnamed Client')
  END AS xero_contact_name,
  CASE
    WHEN group_key = 'UNLINKED' THEN NULL
    ELSE MAX(client_name)
  END AS client_name,
  COUNT(*) AS total_hires,
  COALESCE(SUM(excess_amount_taken), 0) AS total_taken,
  COALESCE(SUM(claim_amount), 0) AS total_claimed,
  COALESCE(SUM(reimbursement_amount), 0) AS total_reimbursed,
  -- Canonical balance held — from v_excess_held (rolled_over/released excluded,
  -- pre-auth holds included). This is the corrected figure.
  COALESCE(SUM(held_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'needed') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count,
  COUNT(*) FILTER (WHERE dispatch_override = true) AS override_count
FROM base
GROUP BY group_key;

-- Restore SELECT grants for the backup user (DROP VIEW removed them).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON client_excess_ledger TO ooosh_backup;
    GRANT SELECT ON v_excess_held TO ooosh_backup;
  END IF;
END $$;
