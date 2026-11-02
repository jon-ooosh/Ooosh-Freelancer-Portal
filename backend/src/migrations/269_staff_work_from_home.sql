-- ============================================================================
-- 269: Staff Calendar — working from home (spec §19, agreed Oct 2026)
-- ============================================================================
-- "Who is in" answered who is CONTRACTED and not off. It did not answer who is
-- in the BUILDING, and for a warehouse those differ: somebody at home cannot
-- take a delivery or let a client in.
--
-- A location is an ATTRIBUTE OF A WORKING DAY — nothing about leave, absence
-- or the ledger is involved (§19, "Is this the marker again?"). Two sources,
-- jon's decisions of Oct 2026:
--   * a REGULAR agreed home day lives on the working pattern
--     (`at_home` on the pattern day), set by an admin, effective-dated with
--     the rest of the pattern — nobody requests it every week;
--   * a ONE-OFF home day is REQUESTED and approved like holiday.
-- Whole days only, and only "home" — in the building, or working but not here.
-- ============================================================================

ALTER TABLE staff_working_pattern_days
  ADD COLUMN IF NOT EXISTS at_home BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS staff_wfh_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','declined','withdrawn','cancelled')),
  request_note  TEXT,
  requested_by  UUID REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_wfh_range CHECK (end_date >= start_date)
);

-- Overlap between two LIVE requests is refused in services/staff-wfh.ts;
-- this index is what makes that check and the calendar overlay cheap.
CREATE INDEX IF NOT EXISTS idx_staff_wfh_live
  ON staff_wfh_requests (person_id, start_date, end_date)
  WHERE status IN ('pending','approved');
