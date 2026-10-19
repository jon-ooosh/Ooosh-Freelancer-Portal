-- 121_ve103b_generated_via.sql
-- Track HOW a VE103B certificate was generated so the certificates list can
-- surface the method on hover. The creating user (generated_by) and the time
-- (created_at) were already captured; the METHOD was not.
--
-- Values: 'book_out'           — generated during the van book-out desk gate
--         've103b_board'       — generated from the VE103B page, "From Assignment"
--         've103b_board_manual'— generated from the VE103B page, "Manual Entry"
--
-- NOTE on history: book-out and the board's "From Assignment" mode both call
-- POST /ve103b/generate identically, so historical assignment-linked certs
-- can't be told apart — they stay NULL ("Method not recorded"). Manual board
-- entries went through /test-generate (no assignment_id) and ARE unambiguous,
-- so we backfill those.

ALTER TABLE ve103b_certificates
  ADD COLUMN IF NOT EXISTS generated_via TEXT;

-- Backfill the unambiguous historical case: no assignment link == manual board
-- entry (the /test-generate path).
UPDATE ve103b_certificates
   SET generated_via = 've103b_board_manual'
 WHERE generated_via IS NULL
   AND assignment_id IS NULL;
