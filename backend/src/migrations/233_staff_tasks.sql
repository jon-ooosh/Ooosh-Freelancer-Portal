-- ============================================================================
-- 233: staff_tasks — "things that need doing", owned by a person
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §6 and §8 Phase 3.
--
-- Built GENERAL and wired to ONE consumer. The staff-records module needs
-- somewhere for review actions to live (§5), and jon separately wants a home
-- for non-hire-related things that need doing. Those are the same table, so it
-- is shaped for the second and used by the first.
--
--   source_type / source_id is the hook. A review action is
--   ('staff_review', <review id>); anything typed in by hand is
--   ('manual', NULL). When the general module arrives it needs no migration.
--
-- Deliberately NOT called staff_review_actions: that name would guarantee a
-- second table later. Nothing existing fits — `job_issues` is job-anchored
-- (job_id NOT NULL, mig 075) and cannot hold "book Will's first-aid course".
--
-- WHY person_id IS THE OWNER, NOT AN ASSIGNEE FLAG: the point of §6.2 is that
-- "what should Ooosh do differently?" produces actions the COMPANY owes, and
-- those are the ones that quietly lapse. jon is a person with a people row, so
-- an action he owes lands on his own list beside everything else. That is the
-- mechanism, not a reporting nicety.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHOSE list this appears on.
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  title         TEXT NOT NULL,
  detail        TEXT,
  due_date      DATE,

  -- 'cancelled' rather than a delete, per CLAUDE.md. A task somebody decided
  -- not to do is a different fact from a task that never existed, and a review
  -- action that was dropped is exactly the thing next year's review asks about.
  status        VARCHAR(20) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'done', 'cancelled')),

  -- The generalisation hook. Free-form on purpose: a new source is a new
  -- string, not a migration. NOT a foreign key — it points at different tables
  -- depending on source_type, so the database cannot enforce it and pretending
  -- otherwise with a constraint would just block the next consumer.
  source_type   VARCHAR(30) NOT NULL DEFAULT 'manual',
  source_id     UUID,

  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,

  -- Once, not daily. Same stamp pattern as rtw_chased_at (mig 214): a nag that
  -- repeats every morning is a nag people learn to ignore.
  chased_at     TIMESTAMPTZ
);

-- THE read: "what is on my list". Open tasks, soonest first.
CREATE INDEX IF NOT EXISTS idx_staff_tasks_person_open
  ON staff_tasks(person_id, due_date)
  WHERE status = 'open';

-- "What did this review produce?" — and the general lookup for any future
-- source that wants its own tasks back.
CREATE INDEX IF NOT EXISTS idx_staff_tasks_source
  ON staff_tasks(source_type, source_id)
  WHERE source_id IS NOT NULL;

-- The daily chaser: overdue, still open, not yet chased.
CREATE INDEX IF NOT EXISTS idx_staff_tasks_due_chase
  ON staff_tasks(due_date)
  WHERE status = 'open' AND chased_at IS NULL AND due_date IS NOT NULL;

COMMENT ON TABLE staff_tasks IS
  'Things a person needs to do. General by design (source_type/source_id); Phase 3 wires the manual source and the My To Do tab, Phase 4 adds staff_review actions. See docs/STAFF-RECORDS-SPEC.md §6.';

COMMENT ON COLUMN staff_tasks.person_id IS
  'The OWNER — whose My To Do list this shows on. An action the company owes lands on the responsible person''s own list.';

COMMENT ON COLUMN staff_tasks.source_type IS
  '''manual'' for anything typed in; ''staff_review'' for an action agreed at a review (Phase 4). Not a foreign key: source_id points at a different table per type.';
