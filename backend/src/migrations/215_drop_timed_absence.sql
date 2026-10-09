-- ============================================================================
-- 215: Staff Calendar & Time — remove timed absence markers
-- ============================================================================
-- Migration 214 shipped spec §7.5's "timed appointment marker": a non-deducting
-- absence of a few hours ("out 14:00–15:00"), which staff could record for
-- themselves, so the calendar knew the office was short at 2pm.
--
-- IT IS BEING REMOVED, a few days later, because it was the wrong feature. The
-- module answers two questions — how much time has someone worked, and how much
-- time are they taking off — and a marker answers neither. It deducted nothing,
-- approved nothing and belonged to no account; it was a presence tracker
-- wearing an absence row's clothes, and carrying it would have meant every
-- future rule in this module having to say "…except markers".
--
-- WHAT SURVIVES, and is deliberately untouched:
--   * TIMED LEAVE (staff_leave_request_days.portion = 'hours', migration 212).
--     "Leaving at 15:00 on Thursday" is time off, it deducts, it is approved.
--     That is the thing people actually asked for.
--   * HALF-DAY ABSENCE ('am' / 'pm'). Someone who goes home ill after lunch is
--     recorded as a 'pm' absence, which is what the portion column is for.
--
-- So an absence day is once again whole, morning or afternoon — and because a
-- person can now hold at most ONE absence per day, the overlap trigger that
-- existed purely to keep two markers apart goes with it.
-- ============================================================================

-- ── Clear any rows the feature left behind ──────────────────────────────────
-- It was live in production for a few days, so this is not hypothetical. A
-- CHECK constraint applies to every row including retired ones, so the day
-- rows have to go rather than just be deactivated.
DO $$
DECLARE
  timed_days INT;
BEGIN
  SELECT COUNT(*) INTO timed_days FROM staff_absence_days WHERE portion = 'hours';

  IF timed_days = 0 THEN
    RAISE NOTICE '215: no timed absence rows to clear';
  ELSE
    RAISE NOTICE '215: clearing % timed absence day row(s)', timed_days;

    -- 1. Give back anything they charged FIRST, while the rows still exist to
    --    be found. Markers themselves never deducted, but an admin could have
    --    ticked "deduct from allowance" on a timed absence, and dropping the
    --    day without reversing the debit would leave the ledger holding a
    --    charge for time that no longer exists anywhere. The ledger is
    --    append-only, so there would be no tidying it up afterwards.
    INSERT INTO staff_ledger_entries
      (person_id, account, leave_year, entry_type, minutes, effective_date,
       source_type, source_id, reverses_entry_id, note)
    SELECT e.person_id, 'holiday', e.leave_year, 'cancellation', -e.minutes,
           e.effective_date, 'absence', e.source_id, e.id,
           'Timed absence withdrawn — the feature was removed (migration 215)'
      FROM staff_ledger_entries e
     WHERE e.source_type = 'absence'
       AND e.entry_type  = 'booking'
       AND e.source_id IN (SELECT DISTINCT absence_id FROM staff_absence_days WHERE portion = 'hours')
       AND NOT EXISTS (
             SELECT 1 FROM staff_ledger_entries r WHERE r.reverses_entry_id = e.id);

    -- 2. Soft-cancel the parent absences, per CLAUDE.md. The header stays, so
    --    anyone who wonders where their dentist entry went can still see it.
    UPDATE staff_absences
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancellation_reason = 'Timed absence markers removed from the module',
           updated_at = NOW()
     WHERE status = 'active'
       AND id IN (SELECT DISTINCT absence_id FROM staff_absence_days WHERE portion = 'hours');

    DELETE FROM staff_absence_days WHERE portion = 'hours';
  END IF;
END $$;

-- ── The overlap trigger existed only for markers ────────────────────────────
-- It kept two timed periods in one day from overlapping, and kept a marker out
-- of a day someone was already off for. With one absence per day both are
-- impossible by construction, and the unique index below says so.
DROP TRIGGER  IF EXISTS trg_staff_absence_day_no_clash ON staff_absence_days;
DROP FUNCTION IF EXISTS staff_absence_day_no_clash();

-- ── One absence per person per day, with no exception ───────────────────────
-- Migration 214's index excluded portion = 'hours' so that several markers
-- could share a day. Nothing is excluded now.
DROP INDEX IF EXISTS idx_staff_absence_one_per_day;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_absence_one_per_day
  ON staff_absence_days(person_id, absence_date)
  WHERE is_active;

-- ── Make it impossible to create another one ────────────────────────────────
-- The columns stay. They are nullable, now always NULL, and cost nothing; if
-- timed absence is ever genuinely wanted, relaxing these two constraints is
-- the whole of the change. Dropping the columns would not be reversible and
-- buys nothing.
ALTER TABLE staff_absence_days DROP CONSTRAINT IF EXISTS staff_absence_days_portion_check;
ALTER TABLE staff_absence_days
  ADD CONSTRAINT staff_absence_days_portion_check CHECK (portion IN ('full','am','pm'));

ALTER TABLE staff_absence_days DROP CONSTRAINT IF EXISTS staff_absence_day_times;
ALTER TABLE staff_absence_days
  ADD CONSTRAINT staff_absence_day_times CHECK (start_time IS NULL AND end_time IS NULL);
