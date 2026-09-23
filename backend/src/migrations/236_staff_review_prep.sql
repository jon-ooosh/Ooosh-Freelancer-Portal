-- ============================================================================
-- 235: Staff Records Phase 5 — the staff-facing half of a review
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §5.3, §5.5 and §8 Phase 5.
--
-- Phase 4 gave jon somewhere to record a review. This gives the OTHER person a
-- part in it: the prep questions before, and the write-up after. Without this
-- a "review" is an appraisal done TO somebody.
-- ============================================================================

-- ── Their answers, and his ──────────────────────────────────────────────────
-- Both sides answer the SAME questions before the meeting (spec §5.3). That is
-- the single highest-leverage part: it turns "boss delivers verdict" into "two
-- documents compared".
--
-- JSONB rather than a row per answer: the question set is editable in
-- system_settings and changes between cycles, so a normalised table would need
-- a questions table, versioning and a join to show a five-year-old review as
-- it was actually asked. The array carries the question TEXT alongside the
-- answer, so an old review always reads back correctly however the current
-- set has moved on.
--   [{"q": "What's gone well…", "a": "…"}, …]
--
-- NOTE for whoever writes to these: node-postgres sends a JS array as a
-- Postgres ARRAY literal, which JSONB rejects — JSON.stringify on write.
-- An EMPTY array survives, so the bug only shows once somebody really answers.
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS self_assessment JSONB;
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS self_assessment_submitted_at TIMESTAMPTZ;
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS manager_prep JSONB;

COMMENT ON COLUMN staff_reviews.self_assessment IS
  'The reviewee''s own answers: [{"q","a"}]. Carries the question text so an old review reads back as it was asked, whatever the current set says.';
COMMENT ON COLUMN staff_reviews.manager_prep IS
  'The reviewer''s answers to the SAME questions. Admin-only, like private_notes.';

-- ── The two stamps ──────────────────────────────────────────────────────────
-- Once, not every time the row is touched. `invited_at` is what stops a second
-- "you have a review" landing every time jon edits a note; `follow_up_sent_at`
-- is what stops the write-up being emailed twice if a completed review is
-- amended afterwards.
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS invited_at        TIMESTAMPTZ;
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS follow_up_sent_at TIMESTAMPTZ;

-- ── The questions ───────────────────────────────────────────────────────────
-- In system_settings so the wording changes without a deploy — jon's existing
-- set is 10+ years old and he intends to rewrite it. Stored as a JSON array of
-- strings; a bad value falls back to the built-in list rather than showing an
-- empty form (services/staff-review-prep.ts).
--
-- Six is about the ceiling before people start writing "n/a". Questions 2 and
-- 6 only get honest answers because pay is settled AFTER the meeting (§5.1) —
-- the question set and that rule are one design, not two.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'staff.review_questions',
  '["What''s gone well since we last talked? Give me a specific example or two.","What hasn''t gone the way you wanted — and what would have helped?","Which parts of the job do you most want more of?","What do you want to be doing in a year that you''re not doing now? What would get you there?","What should Ooosh do differently? What gets in your way?","Anything we haven''t covered, or anything you''ve been sitting on?"]',
  'Staff review prep questions — a JSON array of strings, asked of both sides before a review',
  'staff_time', 'text', 204
)
ON CONFLICT (key) DO NOTHING;
