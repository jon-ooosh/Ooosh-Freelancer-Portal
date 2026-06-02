-- 108_job_financials.sql
--
-- Cached per-job money figures powering the global /money/overview dashboard.
-- This is a DERIVED, refreshable projection — HireHop remains the source of
-- truth. Populated two ways: (a) write-through whenever the Money tab
-- /summary endpoint runs for a job (self-heals operationally-live jobs), and
-- (b) a nightly slow-burn backfill for history (follow-up). Dashboard reads
-- this table only — no HH calls at page load.
--
-- Deliberately a separate table (not columns on `jobs`) so the cache is
-- obviously separable and refreshable, and doesn't bloat the hot `jobs` row.
-- Excess-held is NOT cached here — it's read live from `job_excess` (OP-owned,
-- already real-time).

CREATE TABLE IF NOT EXISTS job_financials (
  job_id              UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  hire_value_inc_vat  NUMERIC(12,2),   -- VAT-adjusted total inc VAT (what the client owes)
  total_hire_deposits NUMERIC(12,2),   -- hire deposits taken (excl. excess), refunds netted
  balance_outstanding NUMERIC(12,2),   -- hire_value_inc_vat - total_hire_deposits (adjusted)
  vat_saved           NUMERIC(12,2) DEFAULT 0,  -- international VAT relief, if any
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stalest-first scan for the nightly backfill.
CREATE INDEX IF NOT EXISTS idx_job_financials_synced ON job_financials(last_synced_at);
