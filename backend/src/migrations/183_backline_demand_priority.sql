-- Backline demand tracker — priority + acquisition (procurement) status.
--
-- Two new axes on top of the existing have_it_status:
--   priority           — how much we want it (high/medium/low). NULLABLE:
--                        matcher-logged rows stay unset ("—") until a human
--                        triages them, so we never claim a priority nobody set.
--   acquisition_status — the plan for the gap: getting_soon / ordered /
--                        not_getting, plus a neutral 'none' default. Distinct
--                        from have_it_status (which is stock-now).
--
-- Also widens have_it_status to add 'used_to' (we stocked it once, don't now).

-- have_it_status: add 'used_to'. The 137 CHECK was an inline column constraint,
-- so Postgres named it <table>_<column>_check. Drop + re-add with the new set.
ALTER TABLE backline_demand DROP CONSTRAINT IF EXISTS backline_demand_have_it_status_check;
ALTER TABLE backline_demand
  ADD CONSTRAINT backline_demand_have_it_status_check
  CHECK (have_it_status IN ('yes', 'no', 'sort_of', 'used_to'));

ALTER TABLE backline_demand
  ADD COLUMN IF NOT EXISTS priority VARCHAR(10)
    CHECK (priority IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS acquisition_status VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (acquisition_status IN ('none', 'getting_soon', 'ordered', 'not_getting'));

-- Purchasing surface: high-priority gaps float to the top.
CREATE INDEX IF NOT EXISTS idx_backline_demand_priority ON backline_demand (priority);
CREATE INDEX IF NOT EXISTS idx_backline_demand_acquisition ON backline_demand (acquisition_status);
