-- 266_vehicle_sales_defaults.sql
-- Vehicle sales tweaks (docs/VEHICLE-SALES-SPEC.md §13).
--
-- 1. Default buyer contact line (jon, 1 Oct 2026). Only fills an EMPTY value —
--    never overwrites what someone has already typed on a sale page.
-- 2. Boilerplate snippets shown beside the sale description — a JSON list of
--    { "title": "...", "text": "..." }, shared by every van, edited on the sale
--    page by admin / manager. Starts empty: OP doesn't invent sales copy.

UPDATE system_settings
   SET value = 'Ooosh Tours - 01273 911382 - info@oooshtours.co.uk', updated_at = NOW()
 WHERE key = 'vehicle_sales_contact' AND (value IS NULL OR btrim(value) = '');

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('vehicle_sales_snippets', '[]', 'Boilerplate text for vehicle sale descriptions', 'vehicle_sales', 'json', 1)
ON CONFLICT (key) DO NOTHING;
