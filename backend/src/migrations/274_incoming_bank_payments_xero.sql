-- 274_incoming_bank_payments_xero.sql
-- A Wise transfer can reference a Xero-only invoice (e.g. "OT-6787" — monthly
-- storage, not a HireHop job). Those are recorded as a Payment on the invoice
-- in Xero, against the Wise bank account (system_settings.xero_bank_wise), and
-- the row remembers what it paid. status stays 'recorded'; matched_job_id is NULL.
ALTER TABLE incoming_bank_payments
  ADD COLUMN IF NOT EXISTS xero_invoice_id     TEXT,
  ADD COLUMN IF NOT EXISTS xero_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS xero_payment_id     TEXT;
