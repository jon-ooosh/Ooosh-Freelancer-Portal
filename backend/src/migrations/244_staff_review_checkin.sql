-- ============================================================================
-- 244: Staff reviews — the check-in between reviews
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §5.6 and §22.
--
-- Half-way between a completed review and the next one due, the Staff page
-- asks for a quick check-in: "here are the actions from last time, where are
-- they?". That needs one fact stored — that it happened — so the prompt goes
-- away. Stamped on the review it follows up, so a new review naturally starts
-- a new cycle with no stamp to clear.
-- ============================================================================

ALTER TABLE staff_reviews ADD COLUMN IF NOT EXISTS checkin_done_at TIMESTAMPTZ;

COMMENT ON COLUMN staff_reviews.checkin_done_at IS
  'When the mid-cycle check-in on THIS review''s actions was done. Only meaningful on a completed review.';
