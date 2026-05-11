-- Migration 082: Default watchers for vehicle issues
--
-- Auto-created vehicle issues (PrepPage / CheckInPage flags) currently
-- ship with empty `watchers[]`, so notifyIssueRecipients short-circuits
-- and nobody gets pinged on the initial flag. The notification value
-- only kicks in on subsequent re-flag / status-change / assignment
-- events.
--
-- This setting plugs that gap: fleet-wide JSON array of user UUIDs
-- that get added to `watchers[]` at creation time for every new
-- vehicle-issue. Typical use — pin jon + Will so any new flag pings
-- whoever's looking after the fleet.
--
-- Format: JSON-encoded array of UUIDs. Empty string or null = no
-- default watchers (same as today's behaviour).
--   '[]'                            → no watchers
--   '["uuid-1"]'                    → one watcher
--   '["uuid-1","uuid-2","uuid-3"]'  → three watchers
--
-- Read via getSystemSetting('vehicle_issue_default_watchers') in the
-- problems route + the auto-create endpoint. Settings-page UI on
-- /settings (admin/manager only).

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'vehicle_issue_default_watchers',
  '[]',
  'Default watchers (JSON array of user IDs) for new vehicle issues',
  'vehicle_issues',
  'json',
  10
)
ON CONFLICT (key) DO NOTHING;
