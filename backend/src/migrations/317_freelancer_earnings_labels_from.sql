-- The portal's Earnings tab (docs/FREELANCER-PORTAL-SPEC.md §5.2, jon, Oct 2026)
-- labels finished work "To invoice" only from this date: when the office began
-- ticking the work each freelancer invoice covers. Earlier invoices were linked
-- to the freelancer but not to their work, so earlier work would read as "To
-- invoice" although it was paid. Move it back if older invoices get their work
-- ticked. A YYYY-MM-DD date; anything else falls back to 2026-10-22.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('freelancer_earnings_labels_from', '2026-10-22',
   'Earnings in the portal: label work "To invoice" from this date (YYYY-MM-DD)',
   'freelancers', 'text', 93)
ON CONFLICT (key) DO NOTHING;
