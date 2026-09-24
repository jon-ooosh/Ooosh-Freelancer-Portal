-- ============================================================================
-- 253: To Do phase 1 — assigning, handing back, the setter's follow-up, privacy
-- ============================================================================
-- docs/TASKS-SPEC.md §5, §8. Built on staff_tasks (mig 233/234) rather than a
-- new table: the review module, the chaser and the tests already use it.
--
-- `created_by` (a users.id, since mig 233) is who SET the task. Until now that
-- was always the owner or an admin; from here anyone can put a task on anyone's
-- list, so it becomes the "Assigned by me" key and needs an index.
-- ============================================================================

-- The SETTER's clock (§5.2). A different question from the owner's
-- next_chase_date: that one asks "did I do it?", this one "did they do it?".
-- Two dates for two people, never one date doing both jobs.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS follow_up_on        DATE;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS follow_up_chased_at TIMESTAMPTZ;

-- Handed back (§5.1): the owner returns it to whoever set it, with a reason,
-- so nothing assigned ever silently disappears. The task moves to the
-- setter's list; these record who sent it back and why.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS handed_back_by     UUID REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS handed_back_reason TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS handed_back_at     TIMESTAMPTZ;

-- Private (§8): visible only to the owner, the setter and admins. Everything
-- else is on the Everyone view.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- Review actions came out of a conversation the staff records spec protects
-- on purpose (§5.4 there). Putting them on a team-wide list would undo that.
UPDATE staff_tasks SET is_private = true
 WHERE source_type = 'staff_review' AND is_private = false;

CREATE INDEX IF NOT EXISTS idx_staff_tasks_created_by
  ON staff_tasks(created_by) WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_staff_tasks_follow_up
  ON staff_tasks(follow_up_on)
  WHERE status = 'open' AND follow_up_on IS NOT NULL AND follow_up_chased_at IS NULL;

COMMENT ON COLUMN staff_tasks.follow_up_on IS
  'The SETTER''s follow-up date — "did they do it?". Separate from next_chase_date, the owner''s nudge.';
COMMENT ON COLUMN staff_tasks.is_private IS
  'Visible only to owner, setter and admins. Default true for review actions.';
