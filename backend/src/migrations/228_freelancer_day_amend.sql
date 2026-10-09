-- 228 — Amending a booking, and telling "pulled out" apart from "declined"
--       (spec §9.4, items 6 and 7).
--
-- WHY AMEND EXISTS. Until now there was no update endpoint at all, so moving a
-- start time by an hour meant cancel-and-rebook: the acceptance was thrown away
-- and the day re-offered. Merely annoying before anything emailed them; once
-- mail goes out it means emailing somebody twice to move an hour.
--
-- WHY `withdrew` IS NOT `declined`. recordResponse allowed accepted → declined,
-- so a freelancer dropping out the day before was recorded identically to one
-- who never wanted the day. Operationally those are different facts — one left
-- a hole at short notice — and they should not look the same when you are
-- deciding who to ask next time. Same reasoning that keeps lapsed out of
-- cancelled (227) and cancelled out of lost on a job.
--
-- Neither `withdrew` nor `lapsed` is a LIVE status, so both free the person's
-- slot on that date and the day can be offered again.

ALTER TABLE freelancer_day_bookings
  DROP CONSTRAINT IF EXISTS freelancer_day_bookings_status_check;
ALTER TABLE freelancer_day_bookings
  ADD CONSTRAINT freelancer_day_bookings_status_check
  CHECK (status IN ('offered','accepted','declined','cancelled','completed','lapsed','withdrew'));

ALTER TABLE freelancer_day_bookings
  ADD COLUMN IF NOT EXISTS amended_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reoffered_at TIMESTAMPTZ;

COMMENT ON COLUMN freelancer_day_bookings.amended_at IS
  'Last time a human changed this booking after it was made. Any field.';
COMMENT ON COLUMN freelancer_day_bookings.reoffered_at IS
  'Last time an amendment moved the DAY or the HOURS and therefore re-opened the question. Rate and notes changes never set this — they are told, not re-asked.';
