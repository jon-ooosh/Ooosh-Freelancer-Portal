-- ============================================================================
-- 262: Staff reviews — the reviewee's private draft of their prep answers
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §5.3, §5.5.
--
-- Until now, saving the prep answers WAS sending them: the one write stamped
-- self_assessment_submitted_at and the reviewer could read self_assessment.
-- My Review now saves as you type, so the half-written version needs somewhere
-- of its own that the reviewer never reads. "Submit to reviewer" copies it
-- into self_assessment and clears these two columns.
--
-- The reviewer side selects column by column (listReviews), so nothing new
-- reaches it by default. getMyReview() is the only reader of these columns.
-- ============================================================================

ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS self_assessment_draft JSONB;
ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS self_assessment_draft_saved_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_reviews.self_assessment_draft IS
  'The reviewee''s unsent prep answers, [{q,a}]. PRIVATE to the reviewee: never selected by any reviewer/admin read. Cleared on submit.';
COMMENT ON COLUMN staff_reviews.self_assessment_draft_saved_at IS
  'When the reviewee last autosaved their draft. Cleared on submit.';
