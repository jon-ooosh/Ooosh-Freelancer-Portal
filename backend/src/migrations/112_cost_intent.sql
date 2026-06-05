-- ============================================================================
-- 112: Cost Capture — cost_intent (quote-actual vs extra)
--
-- Phase B. A job often already carries a quote (e.g. a £300 D&C delivery). The
-- freelancer's actual fee + train + fuel logged against it are ACTUALS consumed
-- by that quote, not new charges to bill the client — recharging them would
-- double-bill. `cost_intent` distinguishes the two:
--
--   quote_actual → part of fulfilling an existing quote. Track spend / variance,
--                  never recharge.
--   extra        → incurred for the job but NOT covered by a quote. Eligible for
--                  recharge to the client (Phase C HH push filters to these).
--
-- Only meaningful on job-linked costs; NULL for overhead / vehicle costs with no
-- job. Existing rows stay NULL (predate the concept) — the recharge guard only
-- blocks 'quote_actual', so NULL costs behave exactly as before.
-- ============================================================================

ALTER TABLE costs ADD COLUMN IF NOT EXISTS cost_intent VARCHAR(20)
  CHECK (cost_intent IS NULL OR cost_intent IN ('quote_actual', 'extra'));

CREATE INDEX IF NOT EXISTS idx_costs_intent ON costs (job_id, cost_intent) WHERE job_id IS NOT NULL;
