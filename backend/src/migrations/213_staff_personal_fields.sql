-- ============================================================================
-- 213: Staff Calendar — the remaining personal fields worth holding
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §3.1.
--
-- "Like to be known as" needed NO migration: people.preferred_name has existed
-- since migration 184 (freelancer onboarding) and the staff roster already
-- displays it — it was simply never editable in the Staff UI. That is a
-- frontend fix, not a schema one, and is the reason this migration is smaller
-- than it might have been.
--
-- What IS added is the short list of things that get USED, judged against the
-- rule agreed for this page: a fact about a person who works here, not
-- configuration that happens to concern staff.
-- ============================================================================

-- Pronouns. Cheap, and the staff calendar is a shared surface where colleagues
-- read each other's names daily — getting someone's pronouns right there costs
-- one column.
ALTER TABLE people ADD COLUMN IF NOT EXISTS pronouns VARCHAR(40);

-- Probation. A date nobody looks at is worthless, so this is surfaced on the
-- staff card with a countdown rather than buried in a form.
ALTER TABLE staff_employment ADD COLUMN IF NOT EXISTS probation_end_date DATE;

-- Notice period, in days. Needed the moment someone resigns, and always
-- remembered as "a month" or "two weeks" by people who then disagree about
-- what that meant.
ALTER TABLE staff_employment ADD COLUMN IF NOT EXISTS notice_period_days INT
  CHECK (notice_period_days IS NULL OR (notice_period_days >= 0 AND notice_period_days <= 365));

-- Drives a "probation ending" nudge alongside the existing review reminder.
CREATE INDEX IF NOT EXISTS idx_staff_employment_probation
  ON staff_employment(probation_end_date)
  WHERE probation_end_date IS NOT NULL AND employment_status = 'employed';

-- DELIBERATELY NOT ADDED, so the next person does not re-litigate it:
--   * Bank details — the accountants hold them; a second copy is
--     payroll-diversion exposure for no operational benefit (spec §3.1).
--   * Dietary requirements / allergies — a real thing for tour catering, but it
--     belongs with whatever books the catering, not on an employment record
--     that only admin can read.
--   * T-shirt size — people.has_tshirt already exists for the yes/no that
--     onboarding actually asks.
