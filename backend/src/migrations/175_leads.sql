-- ============================================================================
-- 175: Leads module (Tour Finder → OP)
-- ============================================================================
-- Spec: docs/TOUR-FINDER-SPEC.md
--
-- Brings the standalone `ooosh-tour-finder` (Ticketmaster cold-lead finder,
-- previously CLI-only + pushing to a dead Monday board) into OP as a Leads
-- module under Jobs. This migration lays the data model for the whole feature;
-- PR 1 uses the collect → detect → score columns. The match / contacts /
-- lifecycle columns are created now (nullable, unused) so later slices don't
-- re-migrate.
--
-- pg_trgm is enabled here for the address-book fuzzy matcher that lands in a
-- later slice. On PG13+ pg_trgm is a "trusted" extension, so the DB owner can
-- create it without superuser — but if the migration user lacks the privilege,
-- run `CREATE EXTENSION pg_trgm;` once as the postgres superuser, then re-run
-- migrations (the runner skips already-applied ones).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- tf_events — internal working cache of raw Ticketmaster events.
-- Never surfaced to staff. Dedup by tm_event_id. `processed` marks artists
-- whose events have already been rolled into tour detection this cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tf_events (
  tm_event_id   TEXT PRIMARY KEY,
  event_name    TEXT,
  artist_name   TEXT,
  tm_artist_id  TEXT,
  venue_name    TEXT,
  venue_city    TEXT,
  event_date    DATE,
  genre         TEXT,
  subgenre      TEXT,
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tf_events_artist ON tf_events (tm_artist_id);
CREATE INDEX IF NOT EXISTS idx_tf_events_processed ON tf_events (processed) WHERE processed = FALSE;

-- ---------------------------------------------------------------------------
-- lead_runs — one row per pipeline run (manual button or scheduled).
-- Drives the UI "last run" stamp + guards against concurrent runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  counts        JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lead_runs_started ON lead_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- leads — the surfaced, actionable tour-level record.
-- One row per detected tour (deduped on lower(artist_name) + first_date).
-- Scoring columns fill in phase 3; match / contacts / lifecycle land later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity
  artist_name             TEXT NOT NULL,
  tm_artist_id            TEXT,
  -- Tour shape
  uk_date_count           INTEGER NOT NULL DEFAULT 0,
  first_date              DATE,
  last_date               DATE,
  venues                  JSONB NOT NULL DEFAULT '[]',
  all_dates               JSONB NOT NULL DEFAULT '[]',
  -- AI scoring (phase 3)
  relevance_score         INTEGER,
  client_tier             INTEGER,
  origin_country          TEXT,
  is_international         BOOLEAN,
  reasoning               TEXT,
  ai_summary              TEXT,
  scored_at               TIMESTAMPTZ,
  -- Address-book match (later slice)
  matched_organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
  match_confidence        TEXT NOT NULL DEFAULT 'none' CHECK (match_confidence IN ('exact', 'partial', 'none')),
  match_candidates        JSONB NOT NULL DEFAULT '[]',
  stream                  TEXT NOT NULL DEFAULT 'cold' CHECK (stream IN ('cold', 'warm')),
  -- Contact research (later slice)
  contacts                JSONB NOT NULL DEFAULT '[]',
  -- Lifecycle
  status                  TEXT NOT NULL DEFAULT 'new'
                            CHECK (status IN ('new', 'reviewing', 'contacted', 'converted', 'dismissed', 'not_relevant')),
  status_reason           TEXT,
  assigned_to             UUID REFERENCES users(id) ON DELETE SET NULL,
  converted_job_id        UUID REFERENCES jobs(id) ON DELETE SET NULL,
  -- Provenance
  lead_source             TEXT NOT NULL DEFAULT 'ticketmaster',
  last_run_id             UUID REFERENCES lead_runs(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup key: same band + same tour-start = one lead (re-detection updates it,
-- lifecycle preserved). A genuinely new tour (different first date) = new lead.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_dedup ON leads (lower(artist_name), first_date);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_stream ON leads (stream);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads (relevance_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_leads_matched_org ON leads (matched_organisation_id) WHERE matched_organisation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Config (staff-editable, category 'leads')
-- ---------------------------------------------------------------------------
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('lead_lookahead_min_weeks',    '3',  'Minimum weeks ahead a tour''s first date must be (drops already-running / too-imminent tours)', 'leads', 'text', 10),
  ('lead_lookahead_max_weeks',    '17', 'How far ahead to look (weeks)',                                                                    'leads', 'text', 20),
  ('lead_tour_min_dates',         '3',  'UK dates needed to count as a tour',                                                               'leads', 'text', 30),
  ('lead_tour_window_weeks',      '6',  'Tour dates must fall within this many weeks',                                                      'leads', 'text', 40),
  ('lead_min_relevance_score',    '6',  'Minimum AI relevance score to surface / research a lead',                                          'leads', 'text', 50),
  ('lead_contact_research_cap',   '20', 'Max cold leads to research for contacts per run',                                                  'leads', 'text', 60),
  ('lead_partial_match_threshold','0.4','Address-book fuzzy-match similarity floor for "could this be?" suggestions (0-1)',                 'leads', 'text', 70),
  ('lead_auto_run_enabled',       'false', 'Run the lead search automatically on a weekly schedule',                                        'leads', 'bool', 80)
ON CONFLICT (key) DO NOTHING;
