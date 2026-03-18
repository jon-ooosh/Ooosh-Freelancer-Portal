-- Migration 026: Add 'fixed' to quotes.calculation_mode CHECK constraint
-- Required for local delivery/collection quotes which use calculation_mode = 'fixed'

ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_calculation_mode_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_calculation_mode_check
  CHECK (calculation_mode IN ('hourly', 'dayrate', 'fixed'));
