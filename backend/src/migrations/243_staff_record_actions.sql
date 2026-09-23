-- ============================================================================
-- 243: Staff Records — one dated action per record
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §22.
--
-- Until now a staff record file could be chased by TWO independent clocks:
--   · expiry     — 30 days before the date printed on it (expiry_chased_at, mig 234)
--   · re-check   — document_date + the type's interval (review_chased_at, mig 239)
-- Each with its own stamp, bell and attention row, so one passport could nag
-- twice. jon, Sep 2026: consolidate to ONE date per record that he sets
-- himself, like the remind-me on a job.
--
-- So the record now carries a single action:
--   action_on        — the date it fires. The form PRE-FILLS it from the two
--                      old clocks (whichever is sooner) and the admin can
--                      change or clear it. NULL = nothing scheduled.
--   action_kind      — 'remind', or 'delete' = flag it for deletion. NEVER an
--                      automatic delete: the bell and the attention row point
--                      at the record, and a human presses Delete. Removing a
--                      right-to-work copy by mistake is irreversible.
--   action_delivery  — bell / email / both, the same three the job remind-me
--                      form offers.
--   action_user_id   — who is told. NULL = every admin.
--   action_note      — optional, shown in the bell.
--   action_chased_at — fired once per date; changing the date clears it.
--
-- expiry_chased_at and review_chased_at are left in place (dropping a column is
-- irreversible and these cost nothing) but NOTHING reads or writes them now.
-- ============================================================================

ALTER TABLE staff_record_files
  ADD COLUMN IF NOT EXISTS action_on        DATE,
  ADD COLUMN IF NOT EXISTS action_kind      VARCHAR(10) NOT NULL DEFAULT 'remind'
                                            CHECK (action_kind IN ('remind', 'delete')),
  ADD COLUMN IF NOT EXISTS action_delivery  VARCHAR(12) NOT NULL DEFAULT 'both'
                                            CHECK (action_delivery IN ('notification', 'email', 'both')),
  ADD COLUMN IF NOT EXISTS action_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS action_note      TEXT,
  ADD COLUMN IF NOT EXISTS action_chased_at TIMESTAMPTZ;

-- Carry the two old clocks over, so no existing record loses its reminder.
-- The same rule the form pre-fills with: 30 days before the printed expiry,
-- or 12 months after the document date for a DVLA check or licence (the
-- built-in intervals in services/staff-doc-cycles.ts), whichever is sooner.
-- LEAST() ignores NULLs, so a record with only one of the two gets that one.
UPDATE staff_record_files
   SET action_on = LEAST(
         CASE WHEN expires_on IS NOT NULL THEN expires_on - 30 END,
         CASE WHEN document_date IS NOT NULL AND doc_type IN ('dvla_check', 'licence')
              THEN (document_date + INTERVAL '12 months')::date END
       )
 WHERE deleted_at IS NULL
   AND action_on IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_record_files_action
  ON staff_record_files(action_on)
  WHERE deleted_at IS NULL AND action_on IS NOT NULL;

COMMENT ON COLUMN staff_record_files.action_on IS
  'The ONE date this record fires on (mig 243). Pre-filled from expiry / re-check interval, editable. NULL = nothing scheduled.';
COMMENT ON COLUMN staff_record_files.action_kind IS
  'remind | delete. delete FLAGS the record for a human to delete — never deletes automatically.';
COMMENT ON COLUMN staff_record_files.expiry_chased_at IS
  'LEGACY since mig 243 — superseded by action_chased_at. Not read or written.';
COMMENT ON COLUMN staff_record_files.review_chased_at IS
  'LEGACY since mig 243 — superseded by action_chased_at. Not read or written.';
