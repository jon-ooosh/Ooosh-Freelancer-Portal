-- ============================================================================
-- 222: Phase E — freelancer day bookings ("yard days")
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §9. Non-staff people booked in to work AT THE
-- YARD for a day: prep, warehouse, an extra pair of hands on a busy get-out.
--
-- NOT the same thing as booking a freelancer to drive a delivery — that already
-- lives in quote_assignments and vehicle_hire_assignments and is not touched
-- here. This is specifically about who is physically in the building, because
-- the staff calendar is used to answer "have we got enough people in" and a
-- freelancer in the yard counts toward that while a freelancer on the road
-- does not.
--
-- STRUCTURALLY SEPARATE FROM EVERYTHING IN PHASES A–D, deliberately (§9.1).
-- No ledger account, no working pattern, no entitlement, no holiday, no
-- overtime. Showing a booked freelancer on a calendar is ordinary operational
-- information; treating them like staff — a contracted pattern, mandatory
-- shifts, accrued leave — is what creates employment-status risk.
--
-- The language is OFFERED → ACCEPTED / DECLINED throughout, never "rostered"
-- and never "assigned". A decline is a response, not a penalty. The rate is
-- agreed per booking rather than imposed by a schedule. That wording is a
-- deliberate part of the design and should not be "tidied up".
-- ============================================================================

-- Rate defaults live on the person and only PRE-FILL a booking (§3.8). The
-- agreed_rate on the booking is the truth, because rates change and a booking
-- from last March must keep the rate that was agreed last March.
ALTER TABLE people ADD COLUMN IF NOT EXISTS default_day_rate      NUMERIC(10,2);
ALTER TABLE people ADD COLUMN IF NOT EXISTS default_half_day_rate NUMERIC(10,2);

CREATE TABLE IF NOT EXISTS freelancer_day_bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  booking_date  DATE NOT NULL,

  start_time    TIME,
  end_time      TIME,
  duration_type VARCHAR(10) NOT NULL DEFAULT 'full_day'
                  CHECK (duration_type IN ('full_day','half_day','hours')),

  rate_type     VARCHAR(20) NOT NULL DEFAULT 'day'
                  CHECK (rate_type IN ('day','half_day','hourly','fixed')),

  -- A SNAPSHOT of what was agreed, never a lookup at read time.
  agreed_rate   NUMERIC(10,2),
  -- Computed on write, so a month of bookings rolls up into expected spend
  -- without re-deriving the rate rules in a report.
  expected_total NUMERIC(10,2),

  status        VARCHAR(20) NOT NULL DEFAULT 'offered'
                  CHECK (status IN ('offered','accepted','declined','cancelled','completed')),

  offered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  response_note TEXT,

  notes         TEXT,

  -- Mirrors quote_assignments: expected vs received vs queried.
  invoice_received    BOOLEAN NOT NULL DEFAULT false,
  invoice_amount      NUMERIC(10,2),
  invoice_queried     BOOLEAN NOT NULL DEFAULT false,
  invoice_query_notes TEXT,

  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  cancelled_by        UUID REFERENCES users(id),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- A timed booking carries its times; a whole or half day must not, so the
  -- calendar never has to guess what 09:00 means on a "full day" row. Same
  -- rule as staff_leave_request_days (migration 212).
  CONSTRAINT freelancer_day_times CHECK (
    (duration_type = 'hours' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    OR
    (duration_type <> 'hours' AND start_time IS NULL AND end_time IS NULL)
  )
);

-- ── One LIVE booking per person per day ─────────────────────────────────────
-- 'offered' and 'accepted' are live; declined, cancelled and completed are
-- not. Two live bookings for the same person on the same day would double the
-- expected spend and show them twice in the headcount, which is the number
-- this whole feature exists to get right.
--
-- Someone genuinely in for two separate stints is ONE booking with the wider
-- window and a note — the same call the leave design made, and for the same
-- reason: a per-period scheme makes "is this person in" much harder to answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_freelancer_day_one_live
  ON freelancer_day_bookings (person_id, booking_date)
  WHERE status IN ('offered','accepted');

CREATE INDEX IF NOT EXISTS idx_freelancer_day_date ON freelancer_day_bookings (booking_date)
  WHERE status IN ('offered','accepted','completed');
CREATE INDEX IF NOT EXISTS idx_freelancer_day_person
  ON freelancer_day_bookings (person_id, booking_date DESC);
CREATE INDEX IF NOT EXISTS idx_freelancer_day_invoice
  ON freelancer_day_bookings (booking_date)
  WHERE status = 'completed' AND invoice_received = false;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON freelancer_day_bookings TO ooosh_backup;
  END IF;
END $$;
