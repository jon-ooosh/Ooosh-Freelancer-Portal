-- ============================================================================
-- 212: Staff Calendar & Time — Phase C (overtime, the bank) + timed leave
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §6, §7.5.
--
-- THE BANK, not a disposition at approval (spec §6.2). An approved overtime
-- entry credits the 'overtime' ledger account and NOTHING is decided about
-- what it becomes. During a busy run nobody knows yet whether they want the
-- day off or the pay, and forcing the choice at approval is the main thing
-- wrong with how this usually gets built. The bank is then drawn down two
-- ways, both debits against the same account:
--
--     time off  → a leave request with leave_type = 'toil'  → 'spend_toil'
--     pay       → an admin cash-out into a payroll period   → 'spend_paid'
--
-- The entry row is never mutated; the decision is a new ledger entry.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_overtime_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  work_date     DATE NOT NULL,

  -- Informational. Someone remembering "I came in an hour early" should not
  -- have to reconstruct clock times to log it, so these stay optional.
  start_time    TIME,
  end_time      TIME,

  -- Five-minute granularity (spec §6.1). Enforced here rather than in the UI
  -- so an API caller cannot bank 3 minutes and make every total ugly.
  minutes       INT NOT NULL CHECK (minutes > 0 AND minutes % 5 = 0),

  reason        TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','cancelled')),

  submitted_by  UUID REFERENCES users(id),
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NO unique constraint on (person_id, work_date), deliberately. "Came in an
-- hour early AND stayed thirty minutes late" is TWO entries — simpler than a
-- multi-segment editor, and it matches how people actually remember a day.
CREATE INDEX IF NOT EXISTS idx_staff_overtime_person  ON staff_overtime_entries(person_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_staff_overtime_pending ON staff_overtime_entries(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_staff_overtime_date    ON staff_overtime_entries(work_date);

-- ── Payroll batches ─────────────────────────────────────────────────────────
-- A record of what was generated and when it went, NOT a stamp on the ledger:
-- staff_ledger_entries is append-only, so a batch id cannot be written back
-- onto the rows it covers. Generation is therefore defined purely by the date
-- range and is idempotent — re-running the same period produces the same CSV.
CREATE TABLE IF NOT EXISTS staff_payroll_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  generated_by UUID REFERENCES users(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  sent_note    TEXT,
  CONSTRAINT staff_payroll_period CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_staff_payroll_period ON staff_payroll_batches(period_start, period_end);

-- ── Timed leave (spec §7.5, extended) ───────────────────────────────────────
-- Leave could previously only be a full day or a half (am/pm). Staff also want
-- to book an actual period — "leaving at 3 on Thursday" — and with minutes as
-- the unit of account that costs nothing to support: the duration IS the
-- charge, exactly as it already is for a half day.
--
-- One live leave row per person per date still holds (the unique index from
-- migration 209), so a day carries one leave period rather than several. Two
-- separate absences in one day are rare enough to book as a wider window; the
-- alternative is a partial-index scheme that makes double-booking detection
-- considerably harder to reason about.
ALTER TABLE staff_leave_request_days
  DROP CONSTRAINT IF EXISTS staff_leave_request_days_portion_check;

ALTER TABLE staff_leave_request_days
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time   TIME;

ALTER TABLE staff_leave_request_days
  ADD CONSTRAINT staff_leave_request_days_portion_check
  CHECK (portion IN ('full','am','pm','hours'));

-- A timed period must carry its times; a full or half day must not.
ALTER TABLE staff_leave_request_days
  DROP CONSTRAINT IF EXISTS staff_leave_day_times;
ALTER TABLE staff_leave_request_days
  ADD CONSTRAINT staff_leave_day_times CHECK (
    (portion = 'hours' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    OR
    (portion <> 'hours' AND start_time IS NULL AND end_time IS NULL)
  );

-- ── Ledger: 'cancellation' is valid on the overtime account too ─────────────
-- Cancelling an approved TOIL day returns the minutes to the bank. That is the
-- same concept as cancelling a holiday, and migration 208 allowed the type on
-- the holiday account only — so the credit had to be posted as a 'correction',
-- which reads wrongly in the ledger for what is an ordinary cancellation.
ALTER TABLE staff_ledger_entries
  DROP CONSTRAINT IF EXISTS staff_ledger_entry_type_matches_account;
ALTER TABLE staff_ledger_entries
  ADD CONSTRAINT staff_ledger_entry_type_matches_account CHECK (
    (account = 'holiday'  AND entry_type IN
      ('entitlement','adjustment','booking','cancellation','correction','carry_over'))
    OR
    (account = 'overtime' AND entry_type IN
      ('accrual','spend_toil','spend_paid','year_end_cashout','cancellation','adjustment','correction'))
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_overtime_entries TO ooosh_backup;
    GRANT SELECT ON staff_payroll_batches  TO ooosh_backup;
  END IF;
END $$;
