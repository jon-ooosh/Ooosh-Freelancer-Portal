-- ============================================================================
-- 239: Phases 6 and 7 — document review cycles, and retention
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §4, §7, §19.
--
-- PHASE 6 IS NOW SEPARATE FROM THE DRIVER SYSTEM, by jon's decision (Sep 2026):
-- "completely ignore the driver system — that's for verifying self-drive-hire
-- clients. The process for staff is just an annual sanity check that they're
-- declaring everything they should be."
--
-- That settles §1.1/§1.2 by removing the question. Nothing here reads
-- `drivers`. A staff DVLA check is a staff_record_files row with
-- doc_type = 'dvla_check' and a document_date; the annual cycle derives from
-- that and nothing else. The 30-day hire-insurability window in
-- services/driver-validity.ts is a different question about different people
-- and stays untouched.
-- ============================================================================

-- ── Phase 6: one chase stamp per document ───────────────────────────────────
-- `expiry_chased_at` (mig 234) covers a document's own printed expiry. This is
-- the OTHER clock: "this needs re-checking on a cycle", which fires even for
-- documents that never expire — the whole point of an annual DVLA check.
-- Separate stamps because a passport can be both nearing expiry AND due a
-- re-check, and one stamp would silence the second.
ALTER TABLE staff_record_files ADD COLUMN IF NOT EXISTS review_chased_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_record_files.review_chased_at IS
  'Last nudge for the REVIEW CYCLE (document_date + the type''s interval). Distinct from expiry_chased_at, which tracks the document''s own printed expiry.';

CREATE INDEX IF NOT EXISTS idx_staff_record_files_review
  ON staff_record_files(doc_type, document_date)
  WHERE deleted_at IS NULL AND document_date IS NOT NULL;

-- ── Phase 7: the absence detail purge ───────────────────────────────────────
-- Decided in staff-calendar §17 item 9: sickness records keep one year, then
-- the MEDICAL DETAIL goes. Not the spell.
--
-- WHAT SURVIVES, AND WHY IT IS NOT NEGOTIABLE: `absence_type` stays. The spec
-- originally said the type expires too, but `getSicknessMinutes()` filters on
-- `absence_type = 'sickness'` and the payroll report reads it — purging the
-- type would silently zero everybody's sickness figures rather than anonymise
-- them. The day rows, their minutes and every ledger effect stay for the same
-- reason. What goes is the finer detail: why they were off, the notes, and the
-- return-to-work conversation.
ALTER TABLE staff_absences ADD COLUMN IF NOT EXISTS detail_purged_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_absences.detail_purged_at IS
  'When the special-category detail was swept (reason_category, notes, rtw_* narrative). The spell, its type, its days and their ledger effects are KEPT — only the medical detail expires.';

CREATE INDEX IF NOT EXISTS idx_staff_absences_purge
  ON staff_absences(end_date)
  WHERE detail_purged_at IS NULL AND end_date IS NOT NULL;

-- ── Settings ────────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  -- Per doc_type, in MONTHS. 0 or absent = no cycle, which is the right answer
  -- for a contract. A bad value falls back to the built-in map rather than
  -- chasing everything or nothing (services/staff-doc-cycles.ts).
  ('staff.doc_review_intervals',
   '{"dvla_check":12,"licence":12,"right_to_work":0,"passport":0,"qualification":0,"contract":0,"medical":0,"other":0}',
   'How often each staff document type needs re-checking, in months. JSON: {"doc_type": months}. 0 = never.',
   'staff_time', 'text', 205),

  ('staff.absence_detail_retention_months', '12',
   'How long sickness detail (reason, notes, return-to-work record) is kept after an absence ends. The absence itself and its pay effects are kept permanently.',
   'staff_time', 'text', 206),

  -- Statutory, and NOT one year: right-to-work evidence must be held for the
  -- whole employment plus two years after it ends (jon, Sep 2026).
  ('staff.rtw_retention_years_after_leaving', '2',
   'Years after someone leaves that right-to-work evidence must still be held. Statutory — check before changing.',
   'staff_time', 'text', 207)
ON CONFLICT (key) DO NOTHING;
