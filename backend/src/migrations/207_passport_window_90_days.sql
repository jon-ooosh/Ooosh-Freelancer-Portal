-- 207: Passport check window 30 days → 90 days
--
-- WHY
-- ---
-- The two halves of the passport check disagreed about how long it lasts.
-- `idenfy-webhook.js` has always written `passportValidUntil = today + 90`,
-- while `VALIDITY_WINDOW_DAYS.passport` was 30. OP's `backfillFromDates` then
-- back-computed the FROM date from the expiry it was handed:
--
--     passport_check_date = (today + 90) - 30 = today + 60
--
-- ...so every passport check recorded a check date SIXTY DAYS AFTER the check
-- actually happened, and staff read that fiction as "Checked on". Louis
-- Salanson / 16507 is the worked example: stored 31 Jul → 30 Aug (exactly 30
-- days apart), from a check that really happened around 1 June.
--
-- Resolved in favour of 90 days from the date of checking — same as the licence
-- window, and still capped by the passport's own printed expiry, which
-- `computeDriverValidity` already applies. The hire-form app now sends
-- `passportCheckDate` (the FROM date) so nothing is back-computed any more.
--
-- WHAT THIS DOES
-- --------------
-- `passport_valid_until` is a STORED derived column — the SQL consumers read it
-- directly and only re-derive on the next write to that driver. Changing the
-- constant alone would leave the driver page (computed, 90d) disagreeing with
-- the drivers-list pills (stored, 30d) until each driver happened to be touched.
-- So re-derive every existing row now.
--
-- Rows whose passport_check_date is itself a back-computed fiction (written
-- before the app started sending the FROM date) stay wrong by up to 60 days —
-- there is nothing on the row to recover the true date from. They correct
-- themselves on the driver's next passport check.
UPDATE drivers
   SET passport_valid_until = LEAST(
         passport_check_date + INTERVAL '90 days',
         COALESCE(passport_expiry, passport_check_date + INTERVAL '90 days')
       )::date,
       updated_at = NOW()
 WHERE passport_check_date IS NOT NULL;
