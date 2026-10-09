-- ============================================================================
-- 229: Credits — money coming BACK from a supplier
-- ============================================================================
-- We bought the wrong-length screws, took them back, and Screwfix refunded the
-- card. Until now OP had no way to say that: `amount_gross` is validated
-- non-negative, so the only tool available was editing the original purchase
-- down — which leaves a row saying £8 against a receipt saying £12.60, VAT that
-- no longer ties to the document, and no record that money came back.
--
-- THE MODEL: the purchase and the refund are two separate real events, so they
-- are two rows. The original is never touched. The credit is an ordinary cost
-- row that happens to be NEGATIVE and knows its parent, so every existing
-- `SUM(amount_gross)` — job actuals, vehicle spend, the allocation-aware
-- by-job read — nets to the true cost with no changes.
--
-- SIGN CONVENTION (the one rule to remember): a credit is ENTERED as positive
-- money by staff and STORED NEGATIVE. `applyCreditSign()` in
-- services/cost-credit.ts is the only place that flips it, so a positive credit
-- or a negative purchase cannot reach the table whatever a caller sends.
--
-- `is_credit` is carried ALONGSIDE the negative amount rather than being
-- derived from it, because a few places must treat a credit differently rather
-- than just add it up: it is never payable (Bills to Pay, batch pay), and it
-- pushes to Xero as a RECEIVE bank transaction, not a SPEND.
-- ============================================================================

-- Money IN, not out. See the sign convention above.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT FALSE;

-- The purchase this credit came back from. Nullable: a refund for something
-- bought before OP (or never captured) is still worth recording, and refusing
-- to save it because the parent can't be found is a gate with no way through.
-- ON DELETE SET NULL — deleting a cost is a hard delete (there is no cascade
-- for credits on purpose; the credit records money that really arrived).
ALTER TABLE costs ADD COLUMN IF NOT EXISTS refund_of_cost_id UUID REFERENCES costs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_costs_refund_of ON costs (refund_of_cost_id)
  WHERE refund_of_cost_id IS NOT NULL;

COMMENT ON COLUMN costs.is_credit IS
  'Money coming back from a supplier (refund / credit note). amount_gross is NEGATIVE. Never payable; pushes to Xero as a RECEIVE.';
COMMENT ON COLUMN costs.refund_of_cost_id IS
  'The purchase this credit refunds. NULL when the original was never captured in OP.';
