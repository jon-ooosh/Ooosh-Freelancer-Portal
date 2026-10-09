-- ============================================================================
-- 209: Staff Calendar & Time — Phase B2 (leave requests)
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §3.5, §5. Requests sit ON TOP of the ledger
-- from migration 208: approving one posts a 'booking' debit, cancelling an
-- approved one posts a 'cancellation' credit. The request rows are the
-- workflow; the ledger remains the single source of truth for the balance.
--
-- WHY A ROW PER DAY (staff_leave_request_days):
--
--   1. Each day SNAPSHOTS the minutes it cost, taken from the working pattern
--      in force when the request was made (spec §0.3). A later hours change
--      must never retroactively alter the cost of an approved holiday.
--
--   2. Non-working days get NO ROW at all. Request Friday to Monday and a
--      weekend is simply not charged — no weekend-skipping logic scattered
--      around the codebase, because the days that cost nothing do not exist.
--
--   3. It is what the calendar, the impact preview and the coverage warnings
--      read. One shape, one answer.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_leave_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- 'holiday' debits the holiday account, 'toil' the overtime bank, 'unpaid'
  -- debits NOTHING — it still occupies the calendar and reaches the payroll
  -- report, but no allowance is consumed.
  leave_type    VARCHAR(20) NOT NULL CHECK (leave_type IN ('holiday','toil','unpaid')),

  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  total_minutes INT  NOT NULL CHECK (total_minutes >= 0),

  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','cancelled','withdrawn')),

  request_note  TEXT,
  requested_by  UUID REFERENCES users(id),   -- may differ from person (admin on their behalf)
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,

  cancelled_by        UUID REFERENCES users(id),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_leave_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_person  ON staff_leave_requests(person_id, start_date);
CREATE INDEX IF NOT EXISTS idx_staff_leave_pending ON staff_leave_requests(status)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_staff_leave_range   ON staff_leave_requests(start_date, end_date)
  WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS staff_leave_request_days (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES staff_leave_requests(id) ON DELETE CASCADE,
  leave_date DATE NOT NULL,

  -- Snapshot of what this day cost when booked. NOT recomputed at read time.
  minutes    INT NOT NULL CHECK (minutes > 0),

  portion    VARCHAR(10) NOT NULL DEFAULT 'full'
               CHECK (portion IN ('full','am','pm')),

  -- Set when this day is reclaimed as sick leave (spec §7.4, Phase D). The
  -- column lands now so the FK exists before the absence tables reference it.
  reclaimed_absence_id UUID,

  UNIQUE (request_id, leave_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_leave_days_date ON staff_leave_request_days(leave_date);
CREATE INDEX IF NOT EXISTS idx_staff_leave_days_req  ON staff_leave_request_days(request_id);

-- ── No double-booking, enforced by the database ─────────────────────────────
--
-- A person must not hold two LIVE (pending or approved) requests covering the
-- same date — otherwise the same day is debited twice and the balance is
-- wrong in a way nobody notices until year end.
--
-- That needs person_id and liveness ON THE DAY ROW, because a unique index
-- cannot reach through a join. Both are denormalised, and a trigger keeps
-- is_live in step with the parent request's status so the two cannot drift.
-- A trigger rather than service code because every path that changes a status
-- would otherwise have to remember, and one that forgets fails silently.

ALTER TABLE staff_leave_request_days
  ADD COLUMN IF NOT EXISTS person_id UUID;
ALTER TABLE staff_leave_request_days
  ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_leave_no_double_booking
  ON staff_leave_request_days(person_id, leave_date)
  WHERE is_live;

CREATE OR REPLACE FUNCTION staff_leave_days_sync_live()
RETURNS trigger AS $$
BEGIN
  UPDATE staff_leave_request_days
     SET is_live = (NEW.status IN ('pending','approved')),
         person_id = NEW.person_id
   WHERE request_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_leave_days_sync_live ON staff_leave_requests;
CREATE TRIGGER trg_staff_leave_days_sync_live
  AFTER UPDATE OF status ON staff_leave_requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION staff_leave_days_sync_live();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_leave_requests     TO ooosh_backup;
    GRANT SELECT ON staff_leave_request_days TO ooosh_backup;
  END IF;
END $$;
