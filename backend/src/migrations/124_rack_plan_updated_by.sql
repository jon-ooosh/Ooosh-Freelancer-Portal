-- 124_rack_plan_updated_by.sql
--
-- Track who last edited a rack plan, for the "last edited by" note on the
-- Job Overview Rack Plan card.

ALTER TABLE rack_plans ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);
