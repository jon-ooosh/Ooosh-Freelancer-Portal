-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — "Real people only" toggle for people pickers
-- Migration 232
-- ============================================================================
-- The reminder pickers filter to users with a current staff_employment record,
-- which is how the platform already tells a real person from a service or test
-- login (see services/staff-notifications.ts approverUserIds(), and the roster
-- note in services/staff-employment.ts).
--
-- That test is only correct once staff_employment is actually POPULATED. While
-- the staff module is being built it holds one row, so the filter would leave
-- exactly one name in the picker and silently hide the rest of the team — a
-- far worse outcome than the service logins it was added to remove.
--
-- There is no non-arbitrary way for code to know "the table is populated now",
-- so a human says so. Default OFF: every picker behaves exactly as it does
-- today until someone turns this on, and it can be turned straight back off
-- from Settings without a deploy if it hides somebody it shouldn't.
-- ============================================================================

INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'assignable_users_require_employment',
  'false',
  'Limit people pickers to current staff (needs staff records set up first)',
  'general',
  'bool',
  120
)
ON CONFLICT (key) DO NOTHING;
