-- ============================================================================
-- 143: PCN fine recharge tracking
--
-- The pay_recharge action recharges the actual fine amount to the client as a
-- custom-priced HireHop billable line (alongside the £35+VAT handling charge),
-- mirroring the cost-capture recharge mechanism. These columns track it so the
-- push is idempotent and the audit is on the record.
-- (handling_charge_applied / handling_amount / hh_charge_pushed_at on the pcns
--  row already track the separate £35 admin fee — migration 130.)
-- ============================================================================

ALTER TABLE pcns ADD COLUMN IF NOT EXISTS fine_recharge_amount     NUMERIC(10,2);
ALTER TABLE pcns ADD COLUMN IF NOT EXISTS fine_recharged_at        TIMESTAMPTZ;
ALTER TABLE pcns ADD COLUMN IF NOT EXISTS fine_recharge_hh_item_id TEXT;
