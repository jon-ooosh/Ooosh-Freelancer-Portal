-- ============================================================================
-- 234: Staff Records Phase 4 — the review record, plus two chase dates
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §5, §8 Phase 4, and §14.2.
--
-- ONE CONCERN PER MIGRATION is the rule 232 broke. These three groups all
-- belong to the staff-records module and touch only its own tables plus
-- staff_employment — nothing shared, nothing that another feature can be taken
-- down by. That is the line: "related to each other", not "in the same file".
-- ============================================================================

-- ── 1. Files: the document's OWN expiry ─────────────────────────────────────
-- `document_date` (mig 232) is the FROM date — issued, signed, checked.
-- `expires_on` is a DIFFERENT fact: the expiry printed on the document itself.
-- A passport, a visa, a first-aid certificate each carry one, and it cannot be
-- derived from when somebody looked at it.
--
-- `services/driver-validity.ts` already makes exactly this split
-- (passport_check_date vs passport_expiry, window = the earlier of the two),
-- and Phase 6 will do the same here: review due = document_date + the type's
-- interval, capped by expires_on.
--
-- Both are INPUTS. Neither is a "valid until" a human computes — spec §1.3.
ALTER TABLE staff_record_files ADD COLUMN IF NOT EXISTS expires_on       DATE;
ALTER TABLE staff_record_files ADD COLUMN IF NOT EXISTS expiry_chased_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_staff_record_files_expiry
  ON staff_record_files(expires_on)
  WHERE deleted_at IS NULL AND expires_on IS NOT NULL;

COMMENT ON COLUMN staff_record_files.expires_on IS
  'The expiry printed ON the document (passport, visa, certificate). An INPUT, distinct from document_date. NULL = does not expire.';

-- ── 2. Tasks: a chase date that RE-ARMS ─────────────────────────────────────
-- Phase 3 shipped a one-shot `chased_at`: an overdue task was nudged once and
-- then never again. That was the wrong shape borrowed from the right rule —
-- `rtw_chased_at` is once-only because a return-to-work conversation is a
-- ONE-TIME EVENT, whereas a to-do is an open-ended commitment. One nudge then
-- silence is precisely the evaporation §6 exists to prevent.
--
-- So: the pipeline model instead (`jobs.next_chase_date`, mig 004, re-armed by
-- services/auto-chase-runner.ts). A date that moves forward each time it fires,
-- and NULL means "never nudge me about this" — which is what a someday-maybe
-- item wants.
--
-- Deliberately NOT copying `jobs.chase_interval_days`: a per-row interval is
-- flexibility `jobs` earned over years of real use. Here the interval is one
-- system_setting and the date itself is editable, which already gives per-task
-- control.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS next_chase_date DATE;

-- Existing open tasks get the same default a new one would: the due date if
-- there is one, else two weeks out. Without this, everything created before
-- today is silently un-chaseable forever.
UPDATE staff_tasks
   SET next_chase_date = COALESCE(due_date, (created_at + INTERVAL '14 days')::date)
 WHERE status = 'open' AND next_chase_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_tasks_next_chase
  ON staff_tasks(next_chase_date)
  WHERE status = 'open' AND next_chase_date IS NOT NULL;

COMMENT ON COLUMN staff_tasks.next_chase_date IS
  'When to nudge next. Re-armed by the chaser while the task stays open; NULL means never nudge. chased_at records the last nudge.';

-- ── 3. Reviews ──────────────────────────────────────────────────────────────
-- staff_reviews has existed since mig 206 with `notes` + `outcome`, and
-- NOTHING has ever written to it — no UI called the routes. Phase 4 wires it
-- up, and splits the one notes field in two before there is anything to
-- migrate.

-- THE decision that could not be retrofitted (spec §5.4). A single notes field
-- that is SOMETIMES shared is a leak waiting to happen, and knowing it might be
-- read, the reviewer self-censors and records nothing worth having. Two
-- columns, from the first migration that has any data in it.
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS shared_summary TEXT;
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS private_notes  TEXT;

-- `notes` is now LEGACY — kept rather than dropped because dropping a column
-- is irreversible and this one is free to leave alone. Anything already in it
-- was written with no expectation of being shared, so it moves to the PRIVATE
-- side. (Empty in practice: nothing ever wrote to it.)
UPDATE staff_reviews SET private_notes = notes
 WHERE notes IS NOT NULL AND private_notes IS NULL;

COMMENT ON COLUMN staff_reviews.notes IS
  'LEGACY, unused — superseded by private_notes (admin-only) and shared_summary (the reviewee sees this). Do not write to it.';

-- The scheduling exchange, trimmed to a confirmation (spec §5.2): seven people
-- once a year is a conversation, not a booking system. The value is that the
-- confirmation carries the prep questions and leaves a record that the review
-- was offered on a date.
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'proposed';

ALTER TABLE staff_reviews DROP CONSTRAINT IF EXISTS staff_reviews_status_check;
ALTER TABLE staff_reviews ADD CONSTRAINT staff_reviews_status_check
  CHECK (status IN ('proposed', 'confirmed', 'completed', 'cancelled'));

-- Rows predating this column are whatever completed_at says they are.
UPDATE staff_reviews SET status = 'completed' WHERE completed_at IS NOT NULL AND status = 'proposed';

-- Spec §5.1: pay is decided AFTER the meeting, not in it, and lands in the
-- follow-up. So a review does not HOLD a figure — it points at the
-- staff_salary_history row it produced, which is already the append-only
-- record of what somebody is on and when it changed.
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS salary_history_id UUID
  REFERENCES staff_salary_history(id) ON DELETE SET NULL;

-- Spec §5.6: cadence per person. A new starter might want monthly; somebody
-- settled, annually. NULL = inherit the company default from system_settings,
-- exactly like bank_holiday_policy and entitlement_weeks already do.
ALTER TABLE staff_employment ADD COLUMN IF NOT EXISTS review_interval_months INT
  CHECK (review_interval_months IS NULL OR (review_interval_months >= 1 AND review_interval_months <= 60));

-- One nudge per person per due review, not one every morning. Cleared whenever
-- a review is booked or completed, so the next cycle chases again.
ALTER TABLE staff_employment ADD COLUMN IF NOT EXISTS review_due_chased_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_staff_reviews_open
  ON staff_reviews(person_id, scheduled_for)
  WHERE status IN ('proposed', 'confirmed');

-- ── 4. Settings ─────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('staff.review_interval_months', '12',
   'How often staff reviews come round (months) — per-person override on the Staff page',
   'staff_time', 'text', 200),
  ('staff.review_lead_days', '28',
   'How far ahead of a review falling due to start reminding',
   'staff_time', 'text', 201),
  ('staff.task_chase_days', '14',
   'My To Do: days between nudges about an outstanding task',
   'staff_time', 'text', 202),
  ('staff.document_expiry_lead_days', '30',
   'How far ahead of a staff document expiring to start reminding',
   'staff_time', 'text', 203)
ON CONFLICT (key) DO NOTHING;
