-- ============================================================================
-- 162_storage_billing_details.sql
--
-- Client Storage — decouple the "next invoice due" reminder from the invoice
-- record, and let a "custom" cadence advance itself.
--
-- Before this, `storage_tenancies.next_bill_date` was doing double duty (both
-- the reminder trigger AND the cycle stamped onto the invoice log), and a
-- `billing_cadence = 'custom'` tenancy had no machine-readable interval, so
-- "Mark invoice sent" could never move the date forward — it got stuck circling
-- the same dead cycle (re-nagging about an invoice already sent). See the
-- Studio 1 / Raygun incident, Jul 2026.
--
-- Two changes:
--   1. A custom interval (value + unit) on the tenancy so custom cadences can
--      auto-advance like monthly/quarterly/annual.
--   2. Richer invoice-log rows: the actual invoice number and the (optional)
--      period the invoice covered, kept separate from the reminder date.
-- ============================================================================

-- 1. Custom cadence interval (only meaningful when billing_cadence = 'custom').
--    Unit whitelist matches the SQL interval builder in routes/storage.ts.
ALTER TABLE storage_tenancies
  ADD COLUMN IF NOT EXISTS billing_custom_interval_value INTEGER,
  ADD COLUMN IF NOT EXISTS billing_custom_interval_unit  TEXT
    CHECK (billing_custom_interval_unit IN ('day', 'week', 'month', 'year'));

-- 2. Invoice-log detail — the invoice number and the covered period, both
--    optional (the invoice itself is the real record; we only surface a
--    reference + period for at-a-glance history).
ALTER TABLE storage_invoice_log
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS period_start   DATE,
  ADD COLUMN IF NOT EXISTS period_end     DATE;
