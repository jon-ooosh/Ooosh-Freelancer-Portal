-- 191: Rename the "Confirmed Alternative Quote" lost reason to make it explicit
-- that the alternative quote was OURS (i.e. the client took a different job from
-- us, so the revenue wasn't lost — it moved). "Competitor" already covers the
-- case where the alternative quote came from someone else.
--
-- WHY A DATA MIGRATION: jobs.lost_reason stores the display LABEL verbatim as
-- free text (there is no enum / lookup table), and the Lost & Cancelled page
-- filters on exact string match (`j.lost_reason = $n`). Renaming the option in
-- shared/types without rewriting the stored rows would orphan every historic
-- job tagged with the old label — they'd stop matching the new filter value and
-- silently disappear from the filtered view.
--
-- Idempotent: re-running matches nothing once applied.

UPDATE jobs
   SET lost_reason = 'Confirmed Alternative Quote (from us)'
 WHERE lost_reason = 'Confirmed Alternative Quote';
