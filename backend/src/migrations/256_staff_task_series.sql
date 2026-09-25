-- ============================================================================
-- 256: To Do phase 2 — repeating to-dos
-- ============================================================================
-- docs/TASKS-SPEC.md §6. A SERIES holds the rule; each time one is due it
-- produces an ordinary staff_tasks row, linked back through the existing
-- source hook: source_type = 'staff_task_series', source_id = the series.
-- So ticking, nudging, the Everyone view and privacy all work on occurrences
-- with no special cases — they ARE tasks.
--
-- At most ONE open occurrence per series (§6.3): the next is made when the
-- open one is ticked or dropped, never ahead of time, so a missed week can't
-- breed a backlog. services/task-recurrence.ts decides the date.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_task_series (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  detail          TEXT,

  -- WHOSE list its occurrences land on. NOT NULL for now; phase 3 (shared
  -- lists, §7) relaxes it for owner-less series such as the bins.
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- schedule   = dates from the calendar ("every Thursday")
  -- after_done = N after the last one was done (bins: calling them in early
  --              resets the next visit) — §6.2
  mode            VARCHAR(12) NOT NULL DEFAULT 'schedule'
                    CHECK (mode IN ('schedule', 'after_done')),
  -- {freq, interval, weekdays?, monthly?} — validated by task-recurrence.ts.
  rule            JSONB NOT NULL,
  -- The anchor the schedule counts from (week and month numbering).
  starts_on       DATE NOT NULL,
  ends_on         DATE,
  ends_after      INT CHECK (ends_after IS NULL OR ends_after >= 1),
  occurrences_made INT NOT NULL DEFAULT 0,

  -- proposed: set for somebody else, waiting on Accept / Decline (§6.4)
  status          VARCHAR(12) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('proposed', 'active', 'declined', 'ended')),
  decline_reason  TEXT,
  ended_reason    TEXT,
  is_private      BOOLEAN NOT NULL DEFAULT false,

  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_task_series_person
  ON staff_task_series(person_id) WHERE status IN ('proposed', 'active');
CREATE INDEX IF NOT EXISTS idx_staff_task_series_created_by
  ON staff_task_series(created_by) WHERE status <> 'ended';

-- Occurrences are found by their source; the source index from mig 233
-- (source_type, source_id) already covers "the open one for this series".

COMMENT ON TABLE staff_task_series IS
  'Repeating to-dos (TASKS-SPEC §6). Each occurrence is a staff_tasks row with source_type = staff_task_series.';
