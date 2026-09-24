-- ============================================================================
-- 248: Shop sales — the weekly balance check and its alarms
-- ============================================================================
-- Step 9 of docs/SHOP-SALES-SPEC.md. A scanner compares what OP put on each
-- week's shop job with what HireHop actually has — goods (ex-VAT line total),
-- money (payments less refunds) and the lines themselves — and emails jon
-- when they disagree. The result is stored so the Shop tab can show it
-- without re-reading HireHop on every page load, and so an alarm fires ONCE
-- per distinct problem rather than every fifteen minutes.
-- ============================================================================

ALTER TABLE shop_sale_periods
  ADD COLUMN IF NOT EXISTS last_checked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_check_ok    BOOLEAN,
  -- The full result: expected vs actual per side, missing lines, job status.
  ADD COLUMN IF NOT EXISTS last_check       JSONB,
  -- What was last alerted. A new alert goes only when the problem CHANGES;
  -- cleared when the week balances again, so a later fault alerts afresh.
  ADD COLUMN IF NOT EXISTS alert_signature  TEXT;

-- One email per stuck or failed transaction, not one per scanner pass.
ALTER TABLE shop_sales
  ADD COLUMN IF NOT EXISTS stuck_alerted_at TIMESTAMPTZ;
