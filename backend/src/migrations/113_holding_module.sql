-- ============================================================================
-- 113: Holding module — "Held for Clients" + "Lost Property" + temp storage
--
-- One engine for everything we temporarily hold for a client. Replaces the
-- Monday "Things being sent to us" + "Lost property & temporary storage"
-- boards and the merch/lost-property JotForms.
-- See docs/HOLDING-MODULE-SPEC.md.
--
-- Tables:
--   held_items           — the unified record (kind discriminator drives behaviour)
--   held_item_locations  — managed picklist of physical storage locations
-- ============================================================================

-- ── Storage locations (managed picklist) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS held_item_locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed from the lost-property JotForm radio set (extensible from Settings later)
INSERT INTO held_item_locations (name, sort_order) VALUES
  ('On storage shelves',   10),
  ('In the safe',          20),
  ('Big office',           30),
  ('Corridor',             40),
  ('By downstairs toilet', 50),
  ('Loading bay',          60),
  ('Somewhere else',       900)
ON CONFLICT DO NOTHING;

-- ── Held items ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS held_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  kind                  VARCHAR(20) NOT NULL
    CHECK (kind IN ('incoming', 'lost_property', 'temp_storage')),
  status                VARCHAR(24) NOT NULL DEFAULT 'stored'
    CHECK (status IN (
      'expected',            -- incoming: declared, not yet arrived
      'arrived',             -- incoming/temp: physically received (received_count tracks partials)
      'stored',              -- sitting in a location, awaiting action
      'client_notified',     -- client has been told
      'collection_arranged', -- pickup/courier scheduled
      'collected',           -- lost property / temp storage picked up by client
      'given_to_client',     -- incoming handed over / loaded into the van
      'shipped_back',        -- posted back to client
      'disposed',            -- binned after dispose_after
      'unclaimed',           -- escalation exhausted, nobody came
      'cancelled'
    )),
  owner_unknown         BOOLEAN NOT NULL DEFAULT FALSE,  -- the "mystery box" flag, backfillable

  -- WHO (all nullable until identified)
  owner_person_id       UUID REFERENCES people(id),
  owner_organisation_id UUID REFERENCES organisations(id),
  client_name_text      TEXT,                            -- free text until linked
  job_id                UUID REFERENCES jobs(id),
  hh_job_number         INTEGER,                         -- may be known before the OP job row exists

  -- WHAT
  description           TEXT,
  box_count             INTEGER,                         -- expected/declared
  received_count        INTEGER,                         -- actually arrived (partial arrivals)
  condition_notes       TEXT,
  photos                JSONB NOT NULL DEFAULT '[]'::jsonb,  -- R2 keys (FileAttachment shape)

  -- WHERE FROM (lost property)
  found_in              VARCHAR(20)
    CHECK (found_in IS NULL OR found_in IN ('van', 'rehearsal', 'backline', 'elsewhere')),
  found_vehicle_id      UUID REFERENCES fleet_vehicles(id),
  found_location_text   TEXT,

  -- WHERE NOW
  storage_location_id   UUID REFERENCES held_item_locations(id),
  storage_location_text TEXT,                            -- free text for "Somewhere else"
  storage_room_id       UUID REFERENCES storage_rooms(id),  -- when stored in a Storage Clients room

  -- INBOUND (incoming)
  expected_date         DATE,
  import_charge_flag    VARCHAR(10)
    CHECK (import_charge_flag IS NULL OR import_charge_flag IN ('yes', 'no', 'unknown')),

  -- DEADLINE (forward-looking kinds — usually derived from linked job out_date)
  needed_by             DATE,

  -- MONEY (deferred — flag + notes only for v1)
  chargeable            BOOLEAN NOT NULL DEFAULT FALSE,
  storage_started_at    DATE,
  charge_notes          TEXT,

  -- OUT
  collected_at          TIMESTAMPTZ,
  collected_by          TEXT,                            -- name captured at handover
  return_method         TEXT,                            -- postage method
  tracking_number       TEXT,
  disposed_at           TIMESTAMPTZ,

  -- CHASE (lost property)
  escalation_level      INTEGER NOT NULL DEFAULT 0,      -- 0=none, 1=wk1, 2=wk2, 3=wk3/final
  last_chased_at        TIMESTAMPTZ,
  dispose_after         DATE,

  -- META
  arrived_at            TIMESTAMPTZ,                     -- incoming/temp_storage receipt
  found_date            DATE,                            -- lost property
  notes                 TEXT,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_held_items_kind          ON held_items(kind);
CREATE INDEX IF NOT EXISTS idx_held_items_status        ON held_items(status);
CREATE INDEX IF NOT EXISTS idx_held_items_owner_person  ON held_items(owner_person_id);
CREATE INDEX IF NOT EXISTS idx_held_items_owner_org     ON held_items(owner_organisation_id);
CREATE INDEX IF NOT EXISTS idx_held_items_job           ON held_items(job_id);
CREATE INDEX IF NOT EXISTS idx_held_items_hh_job        ON held_items(hh_job_number);
CREATE INDEX IF NOT EXISTS idx_held_items_needed_by     ON held_items(needed_by);
-- Fast "what's outstanding" / mystery-box / chase scans
CREATE INDEX IF NOT EXISTS idx_held_items_unknown_open
  ON held_items(owner_unknown) WHERE owner_unknown = TRUE AND status NOT IN ('collected', 'given_to_client', 'shipped_back', 'disposed', 'cancelled');
