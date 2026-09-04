-- 161_backline_locations.sql
--
-- "Where is it?" location tracking for prepped backline.
--
-- When a backline card is being worked on / done, staff can record where the
-- physical kit currently sits: loaded into a van (with reg), in the loading
-- bay, in a rehearsal room, or somewhere else (free text). It's a freely
-- editable CURRENT-state attribute — kit might sit in the loading bay two days
-- out, then get loaded into a van the day before — so we keep ONE row per
-- backline requirement (the current location) rather than an event log.
--
-- Pre-hire only. On the way back kit just goes into stock, so we don't track
-- a return location here (that's what Holding / Problems are for).
--
-- The reg is stored as free text (queryable), not an FK: the van holding the
-- kit might be an allocated fleet van, our delivery van, or a client / sub-hire
-- van that isn't in fleet_vehicles at all.

CREATE TABLE IF NOT EXISTS backline_locations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_requirement_id  UUID NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
  job_id              UUID REFERENCES jobs(id) ON DELETE CASCADE,
  location_type       VARCHAR(20) NOT NULL
                        CHECK (location_type IN ('van', 'loading_bay', 'rehearsal', 'other')),
  vehicle_reg         TEXT,   -- populated when location_type = 'van'
  detail              TEXT,   -- free text for 'other', or optional notes
  updated_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  -- One current location per backline card (upsert target).
  CONSTRAINT uq_backline_location_req UNIQUE (job_requirement_id)
);

-- Queryable: "what's loaded in RX22SWN" (future-proofing — not surfaced yet).
CREATE INDEX IF NOT EXISTS idx_backline_locations_reg
  ON backline_locations (vehicle_reg) WHERE vehicle_reg IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_backline_locations_job
  ON backline_locations (job_id);
