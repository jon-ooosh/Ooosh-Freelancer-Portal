-- Remittance advice tracking on costs.
--
-- When a bill/reimbursement is marked paid, staff can optionally send the
-- payee a remittance advice email ("your invoice X was/will be paid on D by
-- method"). These columns record that it went out — powering a "sent ✓" pip,
-- guarding accidental double-sends, and keeping the address it went to for
-- audit / re-send. The email itself is also logged to email_log.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS remittance_sent_at TIMESTAMPTZ;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS remittance_email   VARCHAR(200);
