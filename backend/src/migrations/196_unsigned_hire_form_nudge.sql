-- Migration 196: unsigned hire-form nudge dedup stamps
--
-- A driver can re-verify every document and stop one screen short of signing,
-- leaving no vehicle_hire_assignments row and nothing joining them to the hire
-- (Cameron Williams-Hill / job 16618, Sep 2026). The hourly nudge scanner
-- (services/unsigned-hire-form-nudge.ts) emails them the link once per hire.
-- Stamped BEFORE the send, released on failure — same discipline as
-- referral_alert_sent_at.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS unsigned_nudge_job_number INTEGER,
  ADD COLUMN IF NOT EXISTS unsigned_nudge_sent_at    TIMESTAMPTZ;

COMMENT ON COLUMN drivers.unsigned_nudge_job_number IS
  'HH job the "you have not signed yet" nudge was last sent for. One nudge per (driver, hire).';
COMMENT ON COLUMN drivers.unsigned_nudge_sent_at IS
  'When that nudge went out.';
