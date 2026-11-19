-- ============================================================================
-- 357: Premises & compliance — phase 2 (docs/PREMISES-COMPLIANCE-SPEC.md §14)
-- ============================================================================
--   * Meter readings: a reading check carries its unit ("kWh", "m³") and the
--     meter's serial; a reading record already has reading_value and
--     meter_replaced (mig 355).
--   * The weekly fire alarm test rotates through call points: the check lists
--     them (`points`), each record says which one was tested (`point`), and
--     the next one is the one after the last tested (premises-rules.ts).
--   * Past records (jon, 19 Nov 2026: "backfill historical certs"): records
--     filed later are marked `backfilled` — they never make a "Get it fixed"
--     To Do, and a batch of them moves the due date once, from the newest.
--   * A "Meters" heading and three meters to start from (no owner, no date —
--     nothing reminds anyone until each is set up, as with mig 355's list).
-- ============================================================================

ALTER TABLE premises_checks ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE premises_checks ADD COLUMN IF NOT EXISTS meter_serial TEXT;
ALTER TABLE premises_checks ADD COLUMN IF NOT EXISTS points TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE premises_records ADD COLUMN IF NOT EXISTS point TEXT;
ALTER TABLE premises_records ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT false;

INSERT INTO premises_headings (name, sort_order)
SELECT 'Meters', COALESCE((SELECT MAX(sort_order) FROM premises_headings), 0) + 1
 WHERE NOT EXISTS (SELECT 1 FROM premises_headings WHERE name = 'Meters');

INSERT INTO premises_checks (title, kind, heading_id, place_id, visibility, repeat_mode, repeat_rule, remind_days_before, unit)
SELECT s.title, 'reading', h.id, p.id, 'all', 'after_done', '{"freq":"week","interval":1}'::jsonb, 0, s.unit
  FROM (VALUES ('Gas meter', 'm³'), ('Electricity meter', 'kWh'), ('Water meter', 'm³')) AS s(title, unit)
  JOIN premises_headings h ON h.name = 'Meters'
  JOIN premises_places p ON p.name = 'Whole site'
 WHERE NOT EXISTS (SELECT 1 FROM premises_checks WHERE kind = 'reading');
