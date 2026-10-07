-- A day in lieu for a company day that falls on someone's day off
-- (staff calendar spec §20.5b, jon Oct 2026).
--
-- It is posted by syncCompanyDayLieu() with its OWN source_type, because the
-- two existing candidates would both corrupt something:
--   * 'system' is what syncEntitlement() sums to decide its own delta — a lieu
--     day filed there would be "corrected" away on the next run;
--   * 'manual' is an admin's hand-made adjustment — indistinguishable, and the
--     lieu sync could then never tell what it had posted itself.
--
-- Widening only: every existing row already satisfies the new list.

ALTER TABLE staff_ledger_entries
  DROP CONSTRAINT IF EXISTS staff_ledger_entries_source_type_check;

ALTER TABLE staff_ledger_entries
  ADD CONSTRAINT staff_ledger_entries_source_type_check
  CHECK (source_type IS NULL OR source_type IN
    ('leave_request','overtime_entry','absence','manual','import','system','company_day_lieu'));
