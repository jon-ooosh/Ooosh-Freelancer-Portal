-- 225 — The freelancer day OFFER email (spec §9.4).
--
-- Until now "Offer the day" wrote a row and told nobody, which made the status
-- field a fiction: it said `offered` when nothing had been offered. This adds
-- the bearer token that lets somebody answer from their inbox.
--
-- Mirrors vehicle_hire_assignments.ooh_parking_token (mig 072) rather than
-- inventing a scheme: a long random string, indexed, and no separate expiry
-- column — the booking_date IS the expiry, so there is one date to reason about
-- and it cannot drift from the day being offered.
--
-- Deliberately NOT hashed, unlike portal_password_reset_tokens. That token
-- grants a login; this one sets one day's availability for one person, and the
-- worst a stolen link does is answer a question the person turning up or not
-- immediately contradicts. Hashing would also stop us re-sending the same link
-- in a chase, which §9.4 requires.

ALTER TABLE freelancer_day_bookings
  ADD COLUMN IF NOT EXISTS response_token      TEXT,
  ADD COLUMN IF NOT EXISTS offer_email_sent_at TIMESTAMPTZ;

-- Partial: only live tokens are ever looked up, and a cleared one must not
-- keep a slot in the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fdb_response_token
  ON freelancer_day_bookings(response_token)
  WHERE response_token IS NOT NULL;

COMMENT ON COLUMN freelancer_day_bookings.response_token IS
  'Bearer token for the public accept/decline link. Stays live after a response so re-opening the email still shows the day; dead once booking_date has passed.';
COMMENT ON COLUMN freelancer_day_bookings.offer_email_sent_at IS
  'When the offer email actually went out. NULL means nobody has been told — a backdated record is never emailed.';
