-- ============================================================================
-- 252: Shop sales — sitter-till test accounts
-- ============================================================================
-- The sitter till only sells on the night of the shift (its date, or until
-- 06:00 next morning). A studio evening has ONE shift with ONE sitter, so on
-- a night with a real booking there is no way to test the till without
-- putting test sales on the real sitter's evening — their "tonight" list,
-- lock-up takings and handover summary (jon, Sep 2026).
--
-- Portal accounts listed here may use the till on ANY date they are rostered
-- on: add cover on a free date on the roster, assign the test account, test
-- there. Still needs the roster assignment, so it opens nothing it isn't
-- already allowed to see. Empty the list to switch it off — no deploy.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_till_test_emails',
  '["test123@oooshtours.co.uk"]',
  'Shop — portal test accounts that may use the sitter till on any rostered date',
  'shop',
  'json',
  95
)
ON CONFLICT (key) DO NOTHING;
