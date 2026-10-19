-- Migration 211: cache `client_overpaid` on job_financials
-- ============================================================================
-- The Money tab derives how much a client has OVERPAID from HireHop's invoice
-- `owing` (see routes/money.ts `clientOverpaid`) — money we hold that is owed
-- back, typically a credit note raised after the invoice was paid. Job 15187:
-- a £120 goodwill credit note left the client £120 up, and OP printed
-- "PAID IN FULL · Balance Outstanding £0.00" for months.
--
-- The per-job surfaces now say so. /money/overview cannot: it reads OP only
-- (no HireHop calls at page load, by design), so the figure has to be cached
-- the same way hire_value_inc_vat / balance_outstanding already are — written
-- through whenever a job's Money tab is opened.
--
-- DELIBERATELY NOT BACKFILLED. There is no way to compute this without asking
-- HireHop per job, and a column defaulted to 0 is honest: it says "no
-- overpayment known", not "no overpayment". Jobs populate as their Money tabs
-- are opened, exactly like the rest of this table did (the /overview page says
-- "Cached per-job figures — each job refreshes when its Money tab is opened").
ALTER TABLE job_financials
  ADD COLUMN IF NOT EXISTS client_overpaid NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Partial index: the overview only ever asks for the handful of jobs where this
-- is non-zero, and on a table of thousands that is a very small slice.
CREATE INDEX IF NOT EXISTS idx_job_financials_client_overpaid
  ON job_financials(client_overpaid) WHERE client_overpaid > 0;
