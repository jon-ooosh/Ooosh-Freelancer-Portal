-- 118_cost_invoice_number_and_vat.sql
--
-- Two additions to the cost-capture spine:
--
-- 1. invoice_number — the supplier's invoice/document number. Optional (fuel
--    receipts etc. won't have one), but when present it's the de-dup key so the
--    same invoice can't be submitted/paid twice. Captured at cost-capture time;
--    surfaced on the Bills to Pay screen.
--
-- 2. vat_treatment — how the cost's VAT is pushed to Xero:
--      'standard'      — single inclusive line, Xero derives VAT (default).
--      'reclaim_split' — non-standard "VAT-only" invoices (insurance claims:
--                        excess + reclaimable VAT). Pushed as the 3-line
--                        Exclusive structure (net @ No VAT, vat/0.2 @ 20%,
--                        −vat/0.2 @ No VAT) so the exact VAT is reclaimed.
--    See services/cost-xero-push.ts buildCostLineItems().

ALTER TABLE costs ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100);
ALTER TABLE costs ADD COLUMN IF NOT EXISTS vat_treatment VARCHAR(20) NOT NULL DEFAULT 'standard'
  CHECK (vat_treatment IN ('standard', 'reclaim_split'));

-- De-dup lookup: same supplier + invoice number. Partial (only rows that have a
-- number) and case-insensitive on the supplier so "T.Reeve" / "t.reeve" match.
CREATE INDEX IF NOT EXISTS idx_costs_invoice_dedup
  ON costs (LOWER(COALESCE(supplier_name, '')), invoice_number)
  WHERE invoice_number IS NOT NULL AND invoice_number <> '';
