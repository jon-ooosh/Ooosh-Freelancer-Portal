-- ============================================================================
-- 253: Shop sales — emailed receipts (step 11)
-- ============================================================================
-- docs/SHOP-SALES-SPEC.md §2.10. The customer's document for a shop sale is a
-- VAT RECEIPT, not an invoice — proof of a payment already made (the accountant
-- confirmed Sep 2026 that this is fine; it never goes to Xero). It carries the
-- simplified-VAT-invoice fields: our name, address and VAT number (the client
-- email footer), the time of supply, what was bought, the VAT rate per line and
-- the total. Numbered by the sale's own OT-SHOP reference.
--
-- A refund gets a refund receipt (jon, Sep 2026) — sent against the reversal.
-- Every send is logged here: who it went to, who sent it, whether it went.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shop_receipts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- The sale, or for a refund receipt the reversal row.
  sale_id     UUID NOT NULL REFERENCES shop_sales(id),
  sent_to     TEXT NOT NULL,
  sent_by     UUID REFERENCES users(id),
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error       TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_receipts_sale ON shop_receipts (sale_id, sent_at DESC);
