-- ============================================================================
-- 219: Company days — days off the company grants, not deducted from anyone
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §20. jon grants a couple of extra days a year
-- that should not come out of anybody's allowance, Christmas Day being the
-- standing one: under the `use_allowance` policy it is otherwise an ordinary
-- working day, so without this everyone has to book it off.
--
-- WHY NOT A PATTERN EXCEPTION PER PERSON. staff_pattern_exceptions already
-- makes a date non-working and the calendar already reads it, so it looks like
-- the obvious reuse. It stores a PERSON fact though, and this is a COMPANY
-- fact: seven rows to grant one day, nothing single to edit when it changes,
-- a new starter silently missing out, and no way at all to say "every
-- Christmas Day". One row here grants it to everyone, resolved at read time.
--
-- WHY NOT A NON-DEDUCTING LEAVE TYPE. That is the timed-marker mistake from
-- migration 215 all over again: a leave request nobody requested and nobody
-- approved, which every rule about leave would then have to except.
--
-- IT SUBSUMES `bank_holidays_policy = 'granted'`. If that setting ever flips,
-- the computed bank holidays become company days through this same path rather
-- than a second mechanism doing the same job slightly differently.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_company_days (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- For a one-off this IS the date. For a recurring day it is the first
  -- occurrence, and the month/day of it repeat every year.
  day_date    DATE NOT NULL,
  label       TEXT NOT NULL,

  -- "Every Christmas Day" — the same month and day, annually. jon's answer to
  -- spec §20.4 Q2: recurring for the fixed ones, plus an annual prompt to add
  -- the year's one-offs, because those are the ones nobody remembers.
  recurs      BOOLEAN NOT NULL DEFAULT false,

  -- Soft-cancel, per CLAUDE.md. A company day that has already happened is a
  -- day people did not work; deleting it would rewrite the past calendar.
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'cancelled')),

  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  cancelled_by        UUID REFERENCES users(id),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT
);

-- One-offs: one per date.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_day_one_off
  ON staff_company_days (day_date)
  WHERE status = 'active' AND NOT recurs;

-- Recurring: one per month/day, since the year is only the first occurrence.
-- Without this, "every Christmas Day" could be entered twice from different
-- starting years and nothing would look wrong in the list.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_day_recurring
  ON staff_company_days (EXTRACT(MONTH FROM day_date), EXTRACT(DAY FROM day_date))
  WHERE status = 'active' AND recurs;

CREATE INDEX IF NOT EXISTS idx_company_day_date ON staff_company_days (day_date)
  WHERE status = 'active';

-- ── Giving back holiday a company day has overtaken (spec §20.3) ────────────
--
-- Grant Christmas Day in November and anyone who had already booked it off has
-- paid for a day the company has now given them. Leaving that silently is the
-- mirror image of "never silently move money" — it silently fails to give it
-- back.
--
-- The mechanism is the one migration 214 built for sickness during holiday: a
-- 'correction' credit per day, and a stamp on the leave day so it cannot be
-- reclaimed twice. A SECOND nullable column rather than a generic
-- "reclaimed_by" pair, because both of these are real foreign keys and the
-- database should keep saying so.
ALTER TABLE staff_leave_request_days
  ADD COLUMN IF NOT EXISTS reclaimed_company_day_id UUID;

ALTER TABLE staff_leave_request_days
  DROP CONSTRAINT IF EXISTS staff_leave_days_reclaimed_company_fk;
ALTER TABLE staff_leave_request_days
  ADD CONSTRAINT staff_leave_days_reclaimed_company_fk
  FOREIGN KEY (reclaimed_company_day_id) REFERENCES staff_company_days(id) ON DELETE SET NULL;

-- A day is reclaimed for ONE reason. Both set would mean two credits were
-- posted for the same day, which is the bug this guards against.
ALTER TABLE staff_leave_request_days
  DROP CONSTRAINT IF EXISTS staff_leave_days_one_reclaim_reason;
ALTER TABLE staff_leave_request_days
  ADD CONSTRAINT staff_leave_days_one_reclaim_reason CHECK (
    reclaimed_absence_id IS NULL OR reclaimed_company_day_id IS NULL
  );

CREATE INDEX IF NOT EXISTS idx_staff_leave_days_reclaimed_company
  ON staff_leave_request_days (reclaimed_company_day_id)
  WHERE reclaimed_company_day_id IS NOT NULL;

-- ── The annual prompt (§20.4 Q2) ───────────────────────────────────────────
-- Recurring days look after themselves; the one-offs are what get forgotten.
-- Same shape as the cash-out reminder: a stamp so it fires once a year rather
-- than every morning through November.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('staff.company_days_review_month', '11',
   'Month to ask for next year''s company days (11 = November). Recurring ones need no action',
   'staff_time', 'text', 130),
  ('staff.company_days_reviewed_year', '',
   'Internal — the last year the company-days prompt was sent. Clear it to make it fire again',
   'staff_time', 'text', 310)
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_company_days TO ooosh_backup;
  END IF;
END $$;
