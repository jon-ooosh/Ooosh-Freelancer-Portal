-- Migration 063: Group ledger records by client_name when xero_contact_id is NULL
--
-- Background: the client_excess_ledger view groups job_excess records by
-- xero_contact_id, with NULL values collapsed into a single 'UNLINKED' bucket.
-- Portal-created and derivation-created records don't populate xero_contact_id
-- (we don't yet have xero_contact_id on the organisations table — tracked in
-- CLAUDE.md Step 3 Phase A follow-ups). Migration 060 stopped the summary row
-- mislabelling one random client name as the UNLINKED group's header but did
-- not fix the root issue: every portal/derivation record still dumps into one
-- shared 'Unlinked Records' bucket, making it look like unrelated hires are
-- all for the same client.
--
-- Fix: widen the grouping key. If a record has xero_contact_id, group by that
-- (real Xero contact). Otherwise, if client_name is populated, group by
-- 'name:<client_name>' so hires for the same client bundle together. Only
-- records with neither xero_contact_id nor client_name fall into UNLINKED.
--
-- Ledger route at GET /api/excess/ledger/:xeroContactId understands all three
-- key forms (real ID / 'name:<...>' / 'UNLINKED') and queries job_excess
-- accordingly. Frontend URL-encodes the key.
--
-- Step 1 — backfill client_name on existing records from jobs.client_name.
-- hh-requirement-derivation.ts was previously inserting NULL; the portal
-- payment-event handler already populates client_name on auto-create, so this
-- mostly rescues derivation-created records.

UPDATE job_excess je
SET client_name = j.client_name,
    updated_at = NOW()
FROM jobs j
WHERE je.job_id = j.id
  AND (je.client_name IS NULL OR je.client_name = '')
  AND j.client_name IS NOT NULL
  AND j.client_name <> '';

-- Step 2 — recreate the view with the widened grouping key.

DROP VIEW IF EXISTS client_excess_ledger;

CREATE VIEW client_excess_ledger AS
WITH base AS (
  SELECT
    CASE
      WHEN xero_contact_id IS NOT NULL AND xero_contact_id <> '' THEN xero_contact_id
      WHEN client_name IS NOT NULL AND client_name <> '' THEN 'name:' || client_name
      ELSE 'UNLINKED'
    END AS group_key,
    *
  FROM job_excess
  WHERE excess_status != 'not_required'
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
  COALESCE(SUM(excess_amount_taken), 0)
    - COALESCE(SUM(claim_amount), 0)
    - COALESCE(SUM(reimbursement_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'needed') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count,
  COUNT(*) FILTER (WHERE dispatch_override = true) AS override_count
FROM base
GROUP BY group_key;

-- Restore SELECT grant for the backup user (DROP VIEW removed it)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON client_excess_ledger TO ooosh_backup;
  END IF;
END $$;
