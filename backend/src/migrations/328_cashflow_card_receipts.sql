-- 328: Cash forecast — card spend from receipts logged in OP (Nov 2026).
--
-- Costs already record which card paid (costs.payment_method: cot_card = Capital
-- on Tap, amex, lloyds_cc). Linking each forecast card to its method lets the
-- forecast (services/cashflow-forecast.ts):
--   - raise the card's balance the moment a card receipt is logged after the
--     Monday check-in (jon: "immediate updates on cards put through OP, manual
--     adjustments on a Monday morning");
--   - use the last 90 days of logged card receipts as the typical monthly spend
--     when none is typed. It only knows what was logged, so it runs low.
-- One forecast card per payment method.
ALTER TABLE cashflow_cards
  ADD COLUMN IF NOT EXISTS cost_payment_method VARCHAR(20)
    CHECK (cost_payment_method IS NULL OR cost_payment_method IN ('cot_card', 'amex', 'lloyds_cc'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashflow_cards_cost_method
  ON cashflow_cards (cost_payment_method) WHERE cost_payment_method IS NOT NULL;

UPDATE cashflow_cards SET cost_payment_method = 'cot_card'
 WHERE name = 'Capital on Tap' AND cost_payment_method IS NULL
   AND NOT EXISTS (SELECT 1 FROM cashflow_cards WHERE cost_payment_method = 'cot_card');
UPDATE cashflow_cards SET cost_payment_method = 'amex'
 WHERE name = 'Amex Gold' AND cost_payment_method IS NULL
   AND NOT EXISTS (SELECT 1 FROM cashflow_cards WHERE cost_payment_method = 'amex');
