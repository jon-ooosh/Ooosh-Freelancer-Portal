-- 324: the grey cupboard and key lockbox codes, next to the yard gate code
-- (jon, Nov 2026). One place to update them; the freelancer portal shows them
-- on the day only (services/site-codes.ts): the gate code on any job's page,
-- all three on a studio sitter's shift page. Category 'ooh_returns' so they
-- sit under the gate code in Settings › Out-of-Hours Returns. Empty until set.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('site_cupboard_code', NULL, 'Grey cupboard code (outside; studio sitters see it on the day of their shift)', 'ooh_returns', 'text', 12),
  ('site_lockbox_code',  NULL, 'Key lockbox code (in the grey cupboard; studio sitters see it on the day of their shift)', 'ooh_returns', 'text', 14)
ON CONFLICT (key) DO NOTHING;
