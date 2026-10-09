-- ============================================================================
-- 152: Post-hire expense recharge — the job-level "recharge running costs" flag
--
-- Declared at quote time (any expense line set to charge_mode='recharge') or via
-- the lightweight Tools-menu toggle. Drives: the cost auto-inherit (running-cost
-- costs on this job default to extra + recharge-pending), the standing
-- "Recharge running costs" card, and the check-in fuel-baseline prompt.
--
-- The per-line charge_mode itself lives in the existing quotes.expenses JSONB
-- (no column needed). See docs/POST-HIRE-EXPENSE-RECHARGE-SPEC.md.
-- ============================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recharge_running_costs BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recharge_running_costs_note TEXT;

COMMENT ON COLUMN jobs.recharge_running_costs IS
  'TRUE when this job recharges its running costs post-hire (fuel/parking/etc. billed at actual + markup). Set by a quote recharge line or the Tools-menu toggle.';

-- Standing forward-looking close-out card (distinct from cost_resolve, which is
-- reactive). Created by the derivation engine on flagged jobs.
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('recharge_running_costs', 'Recharge Running Costs', '⛽', NULL, 226)
ON CONFLICT (type) DO NOTHING;
