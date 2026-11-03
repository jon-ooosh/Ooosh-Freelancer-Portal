-- 326: which job does a HireHop invoice number belong to? (Nov 2026)
--
-- The Wise matcher used to find "OT-INV-12347" by opening the billing of the 80
-- jobs with the LATEST start dates — next year's enquiries — so a payment against
-- a finished job's invoice was never found (job 16387, 2 Nov 2026: 196th in line).
-- HireHop cannot look an invoice up by number, but OP already reads each job's
-- billing whenever its Money tab summary runs (and nightly for booked jobs), so it
-- keeps the numbers here as it goes. Filled by services/hh-invoice-index.ts from:
-- the Money tab summary, HireHop's invoice.* webhooks, and the matcher itself.
--
-- A DERIVED, refreshable list — HireHop stays the truth. Deliberately its own table,
-- not columns on job_financials: a webhook refresh must not make the Money overview
-- think a job's money figures are fresh (the nightly refresh picks by last_synced_at).
CREATE TABLE IF NOT EXISTS hh_invoice_index (
  hh_invoice_id   INTEGER PRIMARY KEY,           -- HireHop's invoice id (data.ID)
  invoice_number  TEXT NOT NULL,                 -- as HireHop shows it, e.g. 'OT-INV-12347'
  invoice_digits  TEXT NOT NULL,                 -- '12347' — what a bank reference is matched on
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  hh_job_number   INTEGER NOT NULL,
  status          INTEGER,                       -- HireHop invoice STATUS
  total           NUMERIC(12,2),                 -- gross
  owing           NUMERIC(12,2),                 -- what was still owed when last read
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hh_invoice_index_digits ON hh_invoice_index (invoice_digits);
CREATE INDEX IF NOT EXISTS idx_hh_invoice_index_job ON hh_invoice_index (job_id);
