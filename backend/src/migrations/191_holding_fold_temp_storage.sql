-- ============================================================================
-- 191: Holding — fold `temp_storage` into `incoming`
--
-- `temp_storage` never earned its keep as a separate kind. The only behaviour
-- it had that `incoming` didn't was the visibility of the "hold until" form
-- field — and every scanner that cares (`holding-reminders.ts` hold_until
-- sweep, the needed_by derivation in routes/holding.ts) already treated the
-- two identically via `kind IN ('incoming','temp_storage')`.
--
-- Meanwhile it cost staff a classification decision at capture time, for a
-- case ("band leaves kit with us between two legs of a tour") that is plainly
-- held-for-a-client. Two kinds remain, split by a question staff can always
-- answer — does the client know we've got it?
--
--   incoming      = they sent it / left it with us  → ends in a handover
--   lost_property = we found it                     → ends in collection or
--                                                     disposal, chase ladder
--
-- The CHECK constraint is deliberately left permitting 'temp_storage' — no
-- constraint migration, no risk, and any in-flight caller keeps working. The
-- UI simply stops offering it.
--
-- At time of writing this moves exactly 2 rows, both already terminal
-- (status='collected'), so there is no live behaviour to disturb.
-- ============================================================================

UPDATE held_items
SET    kind = 'incoming',
       updated_at = NOW()
WHERE  kind = 'temp_storage';
