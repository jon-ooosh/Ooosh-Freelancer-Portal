-- ============================================================================
-- 276: Freelancer tasks — things to do on a day booking or a sitter shift
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §21. "Prep this van" (or anything else) for a
-- freelancer in for the day, or a studio sitter on shift.
--
-- NOT the To Do module (staff_tasks is staff-only) and NOT for freelancers on
-- driving jobs — a task is owned by a day booking OR a sitter shift, nothing
-- else (CHECK below).
--
-- NO person_id and NO date, on purpose: both are read through the owner. A
-- sitter reassigned on the day hands the shift's tasks to whoever is now on,
-- and an amended booking date moves its tasks with it. Storing either here
-- would let them drift.
--
-- Soft-cancelled, never deleted: status = 'cancelled'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS freelancer_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_booking_id  UUID REFERENCES freelancer_day_bookings(id),
  shift_id        UUID REFERENCES studio_sitter_shifts(id),
  task_type       VARCHAR(20) NOT NULL CHECK (task_type IN ('van_prep','other')),
  vehicle_id      UUID REFERENCES fleet_vehicles(id),
  job_id          UUID REFERENCES jobs(id),
  description     TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','done','cancelled')),
  done_at         TIMESTAMPTZ,
  done_by_person  UUID REFERENCES people(id),
  done_via        VARCHAR(20) CHECK (done_via IN ('prep_saved','portal','staff')),
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactly one owner.
  CONSTRAINT freelancer_tasks_one_owner CHECK ((day_booking_id IS NULL) <> (shift_id IS NULL)),
  -- A van prep names its van; an 'other' task says what it is.
  CONSTRAINT freelancer_tasks_van_prep_has_van CHECK (task_type <> 'van_prep' OR vehicle_id IS NOT NULL),
  CONSTRAINT freelancer_tasks_other_has_text CHECK (task_type <> 'other' OR COALESCE(TRIM(description), '') <> '')
);

CREATE INDEX IF NOT EXISTS idx_freelancer_tasks_booking ON freelancer_tasks(day_booking_id) WHERE day_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freelancer_tasks_shift   ON freelancer_tasks(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_freelancer_tasks_open_van ON freelancer_tasks(vehicle_id) WHERE status = 'open' AND task_type = 'van_prep';

-- When the freelancer was last told about their tasks ("Send update", or the
-- 16:00 sitter summary), so neither repeats itself.
ALTER TABLE freelancer_day_bookings ADD COLUMN IF NOT EXISTS last_tasks_notified_at TIMESTAMPTZ;
ALTER TABLE studio_sitter_shifts    ADD COLUMN IF NOT EXISTS last_tasks_notified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON freelancer_tasks TO ooosh_backup;
  END IF;
END $$;
