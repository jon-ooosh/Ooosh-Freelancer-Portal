-- 285: the shop's weekly close runs itself on Monday at 08:55
-- (docs/SHOP-SALES-SPEC.md §20.2). jon asked for it on 12 Oct 2026 after four
-- Mondays closed by hand, every one clean. Only a FRESH close whose pre-flight
-- passes is run; a week that stopped part-way waits for the Close button.
-- Set to 'false' to go back to the email alone.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('shop_auto_close_enabled', 'true',
        'Close each finished shop week automatically on Monday morning (invoice, allocate, complete)',
        'money', 'bool', 52)
ON CONFLICT (key) DO NOTHING;
