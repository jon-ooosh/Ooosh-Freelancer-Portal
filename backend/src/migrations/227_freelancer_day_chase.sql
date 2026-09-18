-- 227 — Chasing an unanswered offer, and closing one out (spec §9.4, items 5 + the chase table).
--
-- §9.4 decision 1 says an unanswered offer is NEVER auto-declined: the date
-- passes, it stays `offered`, and it surfaces to admin. That is right — silently
-- removing somebody who may well be planning to turn up is the worse error.
--
-- But it left `offered` with no terminal state at all, so the admin list would
-- grow forever and, six months in, be long enough that nobody reads it. A
-- safety net that is never cleared stops being a safety net. `lapsed` is that
-- terminal state: offered, never answered, day gone, written off by a human.
--
-- NOT the same as `cancelled` and deliberately not folded into it. Cancelled is
-- Ooosh calling the day off; lapsed is nobody ever answering. Conflating them
-- would lose the only signal that says "we asked and heard nothing", which is
-- exactly what you want when deciding who to ask next time. (Same reasoning the
-- platform applies to cancelled vs lost on a job.)

ALTER TABLE freelancer_day_bookings
  ADD COLUMN IF NOT EXISTS offer_chased_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_alerted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_at        TIMESTAMPTZ;

-- The inline CHECK from 222 has to be replaced to admit the new status.
ALTER TABLE freelancer_day_bookings
  DROP CONSTRAINT IF EXISTS freelancer_day_bookings_status_check;
ALTER TABLE freelancer_day_bookings
  ADD CONSTRAINT freelancer_day_bookings_status_check
  CHECK (status IN ('offered','accepted','declined','cancelled','completed','lapsed'));

-- `lapsed` is deliberately absent from idx_freelancer_day_one_live
-- ('offered','accepted'), so writing a day off frees that person's slot and the
-- day can be offered again — to them or to somebody else.

-- Finding what still needs closing: offers whose day has been and gone.
CREATE INDEX IF NOT EXISTS idx_freelancer_day_unanswered
  ON freelancer_day_bookings (booking_date)
  WHERE status = 'offered';

COMMENT ON COLUMN freelancer_day_bookings.offer_chased_at IS
  'The ONE chase to the freelancer fired. Stamped so it cannot repeat — a nag every morning gets filtered, and then the one that mattered is filtered too.';
COMMENT ON COLUMN freelancer_day_bookings.admin_alerted_at IS
  'The day-before "nobody has confirmed for tomorrow" alert to ADMIN fired. Third email goes to us, not to somebody who does not work for us (§9.4 decision 2).';
COMMENT ON COLUMN freelancer_day_bookings.closed_at IS
  'A human wrote off a passed, unanswered offer. Paired with status = lapsed.';

-- Corrected: the chase and the resend both re-send, so this is the LAST send,
-- not the first. NULL still means nobody has been told anything.
COMMENT ON COLUMN freelancer_day_bookings.offer_email_sent_at IS
  'When the offer email LAST went out (the chase and a manual resend both update it). NULL means nobody has been told — a backdated record is never emailed.';
