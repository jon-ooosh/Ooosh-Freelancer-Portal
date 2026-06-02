-- Migration 105: Reconcile vehicle finance columns
--
-- Migration 104 shipped twice with different column sets: an early version with
-- purchase_cost / finance_cost / extra_costs, then a revised version with the
-- finance-agreement model (cash_price, deposit_paid, ...). Because the runner
-- tracks migrations by filename, a server that applied the early 104 then
-- pulled the revised 104 SKIPPED it — leaving the new columns missing and the
-- finance save (PUT /api/vehicles/fleet/:id) failing with a 500.
--
-- This migration makes the schema correct regardless of which 104 ran:
--   - adds the finance-agreement columns IF NOT EXISTS (no-op if already there)
--   - drops the obsolete acquisition-cost columns IF EXISTS (no-op otherwise)
-- It is safe on a fresh DB (104 already added the right columns) and on a
-- server stuck on the early 104.

ALTER TABLE fleet_vehicles
  ADD COLUMN IF NOT EXISTS cash_price          NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS deposit_paid        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS amount_financed     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS monthly_payment     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS finance_term_months INTEGER,
  ADD COLUMN IF NOT EXISTS finance_fees        JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE fleet_vehicles
  DROP COLUMN IF EXISTS purchase_cost,
  DROP COLUMN IF EXISTS finance_cost,
  DROP COLUMN IF EXISTS extra_costs;
