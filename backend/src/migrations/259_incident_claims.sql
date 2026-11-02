-- ============================================================================
-- 259: Incident & possible insurance claims — Phase 1 (the case file)
-- ============================================================================
-- docs/INCIDENT-CLAIMS-SPEC.md. Replaces the broker's Word/PDF motor claim
-- form. A case is ALWAYS opened from a Problem (job_issues) — D1 — and the
-- broker is never contacted automatically (D4).
--
-- Tables:
--   incident_claims        — the case file (one per incident, several Problems)
--   incident_claim_events  — typed audit timeline (mirrors pcn_events), with an
--                            editable event_date for the vehicle manager's
--                            milestone dates (§4)
--   incident_claim_files   — photos / police reports / broker letters, stored
--                            under the claims/ R2 prefix (role-gated in
--                            GET /api/files/download — never under files/)
--
-- job_issues.claim_id is the whole Problem ↔ case link.
--
-- Phase 2 (the client form) adds its own migration for per-recipient links;
-- the driver-signature / declaration columns are created here so the staff
-- form and the broker PDF read one shape from day one.
-- ============================================================================

CREATE TABLE IF NOT EXISTS incident_claims (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  stage                   VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (stage IN ('open', 'form_out', 'submitted', 'reviewed', 'with_broker', 'closed')),
  outcome                 VARCHAR(20)
    CHECK (outcome IN ('not_claimed', 'settled', 'denied', 'defended', 'withdrawn')),
  closed_at               TIMESTAMPTZ,

  -- Anchors
  origin_issue_id         UUID REFERENCES job_issues(id),
  job_id                  UUID REFERENCES jobs(id),
  vehicle_id              UUID REFERENCES fleet_vehicles(id),
  driver_id               UUID REFERENCES drivers(id),       -- NULL until identified
  assignment_id           UUID REFERENCES vehicle_hire_assignments(id),
  hh_job_number           INTEGER,                           -- denormalised for list + subjects
  vehicle_reg             TEXT,                              -- denormalised

  -- The few answers the list / filters need as real columns
  incident_at             TIMESTAMPTZ,
  incident_time_text      TEXT,                              -- as typed ("around 3pm")
  incident_location       TEXT,
  notified_on             DATE NOT NULL DEFAULT CURRENT_DATE, -- when WE heard (milestone, editable)

  -- Everything else the broker form collects (spec Appendix A / §7). Read
  -- whole, never queried — so JSONB. JSON.stringify on write (CLAUDE.md).
  form_data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  sections_done           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Driver declaration + signatures
  driver_declaration      JSONB,
  driver_signature_key    TEXT,
  driver_signed_name      TEXT,
  driver_signed_at        TIMESTAMPTZ,
  policyholder_user_id    UUID REFERENCES users(id),
  policyholder_signature_key TEXT,
  policyholder_signed_name TEXT,
  policyholder_signed_at  TIMESTAMPTZ,

  -- Broker / insurer
  broker_ref              TEXT,       -- Alan Boswell
  insurer_ref             TEXT,       -- Markerstudy
  broker_pdf_key          TEXT,       -- the exact PDF that was sent (frozen)
  broker_sent_at          TIMESTAMPTZ,
  -- Unguessable token behind the PDF's "View full size" photo links (§11).
  -- Minted on first PDF build; dies 90 days after the case closes.
  photo_link_token        TEXT UNIQUE,

  -- Complications
  third_party_claim       BOOLEAN NOT NULL DEFAULT FALSE,
  third_party_claim_notes TEXT,
  liability_dispute       BOOLEAN NOT NULL DEFAULT FALSE,
  liability_dispute_notes TEXT,

  -- Keeping long cases moving (§9.2)
  owner_user_id           UUID REFERENCES users(id),
  next_check_on           DATE,
  next_check_sent_for     DATE,       -- stamp-first dedup for the daily bell

  -- Client chase (Phase 3 — columns now so the shape is settled)
  chase_level             SMALLINT NOT NULL DEFAULT 0,
  chase_sent_for          TEXT,
  chase_paused_at         TIMESTAMPTZ,
  chase_paused_reason     TEXT,

  -- Damage outline + sketch (Phase 2)
  damage_marks            JSONB NOT NULL DEFAULT '[]'::jsonb,
  damage_marks_png_key    TEXT,
  sketch_key              TEXT,

  watchers                UUID[] NOT NULL DEFAULT '{}',
  created_by              UUID REFERENCES users(id),
  is_deleted              BOOLEAN NOT NULL DEFAULT FALSE,     -- soft only
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_claims_vehicle ON incident_claims(vehicle_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_incident_claims_job     ON incident_claims(job_id)     WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_incident_claims_driver  ON incident_claims(driver_id)  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_incident_claims_stage   ON incident_claims(stage)      WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_incident_claims_check   ON incident_claims(next_check_on)
  WHERE is_deleted = false AND stage <> 'closed';

-- ── Timeline ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_claim_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    UUID NOT NULL REFERENCES incident_claims(id) ON DELETE CASCADE,
  event_type  VARCHAR(30) NOT NULL,  -- created / stage_change / milestone / comment /
                                     -- problem_linked / problem_unlinked / file_added /
                                     -- file_removed / ref_recorded / next_check /
                                     -- owner_change / broker_sent / pdf_generated / ...
  event_date  DATE,                  -- milestones only: the date it HAPPENED (editable)
  body        TEXT,
  metadata    JSONB,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_claim_events_claim ON incident_claim_events(claim_id, created_at);

-- ── Files ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incident_claim_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id      UUID NOT NULL REFERENCES incident_claims(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,       -- claims/{claimId}/... (private bucket)
  thumb_r2_key  TEXT,                -- small JPEG for the broker PDF (photos only)
  filename      TEXT NOT NULL,
  file_type     VARCHAR(30) NOT NULL DEFAULT 'other'
    CHECK (file_type IN ('photo', 'police_report', 'broker_correspondence', 'repair_quote', 'other')),
  content_type  TEXT,
  size_bytes    INTEGER,
  caption       TEXT,
  taken_at      TIMESTAMPTZ,         -- photo's original capture time, if known
  uploaded_by   UUID REFERENCES users(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_claim_files_claim ON incident_claim_files(claim_id, uploaded_at);

-- ── Problem ↔ case link ──────────────────────────────────────────────────────
ALTER TABLE job_issues ADD COLUMN IF NOT EXISTS claim_id UUID REFERENCES incident_claims(id);
CREATE INDEX IF NOT EXISTS idx_job_issues_claim ON job_issues(claim_id) WHERE claim_id IS NOT NULL;

-- ── Settings ─────────────────────────────────────────────────────────────────
-- Insured block for the broker PDF (§7.1) + broker address (§11) + the
-- estimated-vehicle-value curve (§6.6). All staff-editable, no deploy needed.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('claims_broker_email',       'SelfDriveHire@alanboswell.com', 'Broker email (claims are sent here)', 'claims', 'text', 10),
  ('claims_default_watchers',   '[]',                             'Default watchers for new claims (JSON array of user ids)', 'claims', 'text', 20),
  ('claims_insured_name',       'Ooosh! Tours Ltd',               'Insured name', 'claims', 'text', 30),
  ('claims_insured_address',    'Compass House, 7 East Street, Portslade, East Sussex, BN41 1DL', 'Insured address', 'claims', 'text', 40),
  ('claims_policy_number',      '000010010635',                   'Policy number', 'claims', 'text', 50),
  ('claims_insured_email',      'info@oooshtours.co.uk',          'Insured email', 'claims', 'text', 60),
  ('claims_insured_phone',      '01273 911382',                   'Insured work phone', 'claims', 'text', 70),
  ('claims_insured_business',   '',                               'Business of insured', 'claims', 'text', 80),
  ('claims_depot',              'Portslade',                      'Depot', 'claims', 'text', 90),
  ('vehicle_value_initial_drop_pct', '10', 'Vehicle value: drop on first registration (%)', 'claims', 'text', 110),
  ('vehicle_value_first_year_pct',   '17', 'Vehicle value: depreciation in year 1 (%)', 'claims', 'text', 120),
  ('vehicle_value_yearly_step_pct',  '1',  'Vehicle value: yearly rate falls by (% points)', 'claims', 'text', 130),
  ('vehicle_value_floor_pct',        '5',  'Vehicle value: yearly rate never below (%)', 'claims', 'text', 140)
ON CONFLICT (key) DO NOTHING;
