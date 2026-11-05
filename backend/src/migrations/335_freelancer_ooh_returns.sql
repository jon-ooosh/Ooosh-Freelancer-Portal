-- 335: out-of-hours van returns for freelancers (jon, Nov 2026;
-- docs/FREELANCER-PORTAL-SPEC.md §8, services/freelancer-ooh-return.ts).
--
-- A freelancer bringing an Ooosh van back to the yard after we've closed (a van
-- they collected from a hirer, a van they took backline out in, or a Van & Driver
-- job) gets the out-of-hours procedure by EMAIL ONLY: the gate code, where to park,
-- the key drop, leave the backline in the van, and a link to tell us where they
-- parked. Staff turn it on with a tick on the freelancer's job (quotes.ooh_return).
--
-- Deliberately NOT the hirer's vehicle_hire_assignments.return_overnight: that flag
-- emails and texts the HIRER and counts late returns against them (ooh-compliance).
-- This table is one row per freelancer on the job, with its own link (the same
-- /return-parking/:token page) and its own record of where they parked.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS ooh_return BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS freelancer_ooh_returns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id       UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  person_id      UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  parking_token  TEXT NOT NULL UNIQUE,
  -- The van, when we know it (the one they collected / the Van & Driver van) or
  -- when they pick it on the form; it drives the GPS pre-fill.
  vehicle_id     UUID REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  info_sent_at   TIMESTAMPTZ,
  returned_at    TIMESTAMPTZ,
  parking_lat    NUMERIC(9,6),
  parking_lng    NUMERIC(9,6),
  parking_notes  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (quote_id, person_id)
);
