-- ============================================================================
-- 258: To Do phase 3 — shared lists
-- ============================================================================
-- docs/TASKS-SPEC.md §7. A list item has NO OWNER until somebody takes it on
-- ("I'll take it" — jon: "like a pull request"). Anyone can add to a list,
-- tick an item or drop it. Watchers get the nudges for items with a date,
-- including repeating ones that live on a list (the bins, the recycling).
--
-- So a task, and a series, now belong to a PERSON, or a LIST, or both (an
-- item somebody took keeps the list it came from). Never neither.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_task_lists (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS staff_task_list_watchers (
  list_id    UUID NOT NULL REFERENCES staff_task_lists(id) ON DELETE CASCADE,
  person_id  UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (list_id, person_id)
);

-- Tasks: owner OR list.
ALTER TABLE staff_tasks ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS list_id UUID REFERENCES staff_task_lists(id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_tasks_owner_or_list') THEN
    ALTER TABLE staff_tasks ADD CONSTRAINT staff_tasks_owner_or_list
      CHECK (person_id IS NOT NULL OR list_id IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_staff_tasks_list
  ON staff_tasks(list_id) WHERE list_id IS NOT NULL AND status <> 'cancelled';

-- Series: the same — the bins are a repeating to-do that lives on a list,
-- owned by nobody, needing nobody's acceptance (§6.4).
ALTER TABLE staff_task_series ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE staff_task_series ADD COLUMN IF NOT EXISTS list_id UUID REFERENCES staff_task_lists(id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_task_series_owner_or_list') THEN
    ALTER TABLE staff_task_series ADD CONSTRAINT staff_task_series_owner_or_list
      CHECK (person_id IS NOT NULL OR list_id IS NOT NULL);
  END IF;
END $$;

-- The two lists jon asked to start with (§12.2). More are one click away.
INSERT INTO staff_task_lists (name)
SELECT v.name FROM (VALUES ('Shopping'), ('Building')) AS v(name)
 WHERE NOT EXISTS (SELECT 1 FROM staff_task_lists l WHERE l.name = v.name);

COMMENT ON TABLE staff_task_lists IS
  'Shared To Do lists (TASKS-SPEC §7). Items are staff_tasks with list_id set and, until taken, no person_id.';
