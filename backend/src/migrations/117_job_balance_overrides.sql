-- 117_job_balance_overrides.sql
--
-- Business-level "ignore this outstanding balance" override for the
-- /money/overview Balances Outstanding list.
--
-- WHY: OP faithfully reads the hire balance from HireHop (staff's source of
-- truth). But the BUSINESS's source of truth is Xero, and the two legitimately
-- diverge: a payment applied in Xero that never fed back to HH, an internal /
-- 100%-discounted job that was never zeroed in HH, a since-corrected HH↔Xero
-- error still showing in HH, or a plain write-off. In all these the HH-derived
-- balance is technically "owed" but the business considers it settled.
--
-- This table lets an admin flag a job's outstanding balance as resolved WITHOUT
-- touching HireHop or Xero. It's a pure OP annotation layer:
--   - /money/overview drops resolved jobs from the active Balances Outstanding
--     list + headline total, surfacing them in a separate "Resolved" section.
--   - The per-job Money tab still shows the live HH balance (staff truth) with a
--     banner explaining it's been resolved as a business adjustment.
--
-- Deliberately a SEPARATE table (not columns on job_financials) so the override
-- is a durable business decision that the financials write-through / nightly
-- backfill can never clobber when it recomputes the cached money figures.
--
-- Reversible: deleting the row un-resolves (audit_log records both directions).

CREATE TABLE IF NOT EXISTS job_balance_overrides (
  job_id       UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  -- xero_settled | internal_discounted | hh_xero_corrected | write_off | other
  reason       VARCHAR(40) NOT NULL,
  notes        TEXT,
  resolved_by  UUID REFERENCES users(id),
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backup user read grant (matches the other OP tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON job_balance_overrides TO ooosh_backup;
  END IF;
END $$;
