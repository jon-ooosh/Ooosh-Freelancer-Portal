-- ============================================================================
-- 247: Shop sales — sale numbers and reversals (Windows A and B)
-- ============================================================================
-- Step 8 of docs/SHOP-SALES-SPEC.md.
--
-- 1. SALE NUMBERS. `OT-SHOP-00100` onwards (§2.10 — starting at 100 is jon's
--    preference). A traceability reference, NOT an accounting invoice number:
--    it rides on the HireHop deposit memo so a Xero line leads straight back to
--    one till transaction, and it will be the receipt number when receipts
--    land. Only SALES take a number — consumption has no money and no receipt,
--    and a reversal is referred to by the sale it reverses.
--
-- 2. REVERSALS (§8). A refund after the drain is TWO real events: the line
--    comes off the HireHop job (stock back on the shelf) and money goes back to
--    the customer. The original sale keeps its row and its status; a linked
--    `kind = 'reversal'` row records the return. Both survive — the audit trail
--    says "they bought it, then brought it back", which is what happened.
-- ============================================================================

-- ── Sale numbers ────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS shop_sale_number_seq START 100;

ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS sale_number INTEGER UNIQUE;

-- Number the sales that already exist, oldest first, so the test sales taken
-- before this migration can be refunded by reference like any other.
UPDATE shop_sales s
   SET sale_number = n.num
  FROM (
    SELECT id,
           (SELECT COALESCE(MAX(sale_number), 99) FROM shop_sales)
             + ROW_NUMBER() OVER (ORDER BY created_at, id) AS num
      FROM shop_sales
     WHERE kind = 'sale' AND sale_number IS NULL
  ) n
 WHERE s.id = n.id;

-- Carry the sequence on from the highest number handed out (99 = none yet, so
-- the next is 100).
SELECT setval('shop_sale_number_seq',
              GREATEST((SELECT COALESCE(MAX(sale_number), 99) FROM shop_sales), 99));

-- ── Reversal bookkeeping ────────────────────────────────────────────────────
-- The HireHop refund payment-application id (billing_payments_save.php
-- OWNER 0 against the sale's deposit). Written the moment HireHop returns it,
-- so a retry can never refund twice.
ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS hh_refund_id INTEGER;

-- The money-back half is manual until Stripe (§8): cash out of the drawer, or a
-- refund keyed on the card terminal. The reversal records it as OUTSTANDING
-- until someone says it has been done.
ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS refund_settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_settled_by UUID REFERENCES users(id);

-- Set on the ORIGINAL sale's line once a reversal has removed it from the
-- HireHop job and the removal has been read back. A retry skips it, so a
-- half-finished reversal can never delete a line twice.
ALTER TABLE shop_sale_lines
  ADD COLUMN IF NOT EXISTS hh_line_removed_at TIMESTAMPTZ;

-- One live reversal per sale. Two staff pressing Refund at once must not
-- refund the customer twice; this makes the second insert fail rather than
-- relying on the application to have checked first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_sales_one_reversal
  ON shop_sales (reverses_sale_id)
  WHERE kind = 'reversal' AND status <> 'cancelled';
