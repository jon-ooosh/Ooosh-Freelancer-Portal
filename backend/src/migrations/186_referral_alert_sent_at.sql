-- ============================================================================
-- Insurance referral alert — idempotency marker (jon, Jul 2026).
--
-- The `referral_alert` email to info@ (with the driver snapshot PDF attached)
-- was previously fired from exactly ONE place — POST /api/hire-forms — so a
-- driver whose SignaturePage chain terminated at POST /api/driver-verification/update
-- (a known intermittent gap) never triggered it. The insurance flag was set,
-- a bell was created for the vehicle manager, but no email went out.
--
-- Fix wires the alert into a second path (the driver-verification signature
-- step) + a daily safety-net scanner. This column is the shared idempotency
-- marker so whichever path completes first sends the alert once, and the
-- other paths + the scanner skip it.
--
-- See CLAUDE.md → "Insurance Referral Workflow" + services/referral-alert.ts.
-- ============================================================================

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS referral_alert_sent_at TIMESTAMPTZ;

-- Partial index for the safety-net scanner: find flagged drivers who signed
-- recently but never got the alert.
CREATE INDEX IF NOT EXISTS idx_drivers_referral_alert_pending
  ON drivers (signature_date)
  WHERE requires_referral = true AND referral_alert_sent_at IS NULL;
