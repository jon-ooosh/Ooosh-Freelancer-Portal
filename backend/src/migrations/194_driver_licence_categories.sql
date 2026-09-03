-- 194 — Record the licence entitlement categories iDenfy already sends
--
-- Licence Details on the driver page showed "—" for Type and Restrictions on
-- essentially every driver, because nothing ever wrote them: the iDenfy
-- dual-write field map carried neither `licenseType` nor `licenseRestrictions`.
-- The values weren't missing, they were never captured.
--
-- iDenfy DOES return `driverLicenseCategory` (e.g. "B,BE,C1") — the webhook has
-- always read it, but only to test for PROVISIONAL/LEARNER, then discarded it.
-- Reaching the end of that check also proves the licence is full, so both facts
-- are now stored.
--
-- A dedicated column rather than reusing `licence_restrictions`: categories are
-- what the driver is ENTITLED to drive, restrictions are conditions imposed on
-- them (glasses, automatic-only). Putting one in a field labelled the other
-- would be actively misleading on an insurance record. `licence_restrictions`
-- is left alone — still no writer, and now dropped from the UI rather than
-- displayed as a permanent dash.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS licence_categories TEXT;

COMMENT ON COLUMN drivers.licence_categories IS
  'Entitlement categories from the licence, as iDenfy reports them (e.g. "B,BE,C1"). '
  'Distinct from licence_restrictions, which are conditions imposed on the driver.';
