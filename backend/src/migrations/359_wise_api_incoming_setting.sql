-- 359: Wise incoming payments read from the Wise API (services/wise-api-incoming.ts).
-- Off until jon switches it on: every 5 minutes OP reads the last 48 hours of the
-- business account's activity and feeds each transfer IN it has not seen to the same
-- matcher as the "Money received" email (which stays on as the backup). Born from
-- transfer #2501093374 (17 Nov 2026), which Wise never emailed about.
-- No screen, like the other money switches:
--   UPDATE system_settings SET value = 'true' WHERE key = 'wise_api_incoming_enabled';
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('wise_api_incoming_enabled', 'false',
        'Read incoming Wise payments from the Wise API every 5 minutes (the email stays as a backup)',
        'money', 'bool', 53)
ON CONFLICT (key) DO NOTHING;
