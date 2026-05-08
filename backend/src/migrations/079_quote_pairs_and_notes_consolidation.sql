-- Migration 079: Crew & Transport calculator cleanups
--
-- Three changes ride together:
--
-- 1. Track HireHop push state per quote (`hh_pushed_at`). Used by the Edit Quote
--    modal to flag "this quote was already pushed to HH; edits won't update HH —
--    update the line item there manually". Set on successful push, cleared if
--    the quote is recalculated (so the banner is correct after a recalc).
--
-- 2. Pair delivery + collection quotes (`paired_quote_id`). When a calculator
--    quote is saved with "also collect from same place", we now save TWO rows
--    (delivery + collection sibling). Each points at the other so the UI can
--    show them grouped and push both to HH together.
--
-- 3. Consolidate notes columns. Three text fields (`key_points`, `freelancer_notes`,
--    `internal_notes`) collapse to two. `key_points` was the legacy Monday-era
--    field that the freelancer portal happened to surface. We backfill its
--    content into `freelancer_notes` (which is what the portal SHOULD surface,
--    semantically), then drop the column. Code change in routes/portal.ts
--    repoints the portal's `keyNotes` response field to read from
--    `freelancer_notes` instead.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS hh_pushed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paired_quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quotes_paired_quote_id ON quotes (paired_quote_id) WHERE paired_quote_id IS NOT NULL;

-- Backfill: merge key_points → freelancer_notes.
-- Rule: if freelancer_notes is empty/null → copy key_points across.
--       if both populated → append key_points after freelancer_notes with separator,
--       so nothing is lost. No-op when key_points itself is empty.
UPDATE quotes
SET    freelancer_notes = CASE
         WHEN COALESCE(NULLIF(TRIM(key_points), ''), NULL) IS NULL THEN freelancer_notes
         WHEN COALESCE(NULLIF(TRIM(freelancer_notes), ''), NULL) IS NULL THEN key_points
         ELSE freelancer_notes || E'\n\n' || key_points
       END,
       updated_at = NOW()
WHERE  COALESCE(NULLIF(TRIM(key_points), ''), NULL) IS NOT NULL;

ALTER TABLE quotes DROP COLUMN IF EXISTS key_points;
