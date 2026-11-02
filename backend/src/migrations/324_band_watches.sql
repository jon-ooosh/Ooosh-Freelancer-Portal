-- 324: Band watch — "tell me when this band is next over" (docs/TOUR-FINDER-SPEC.md §21).
--
-- A watch is on a band (an organisation), never a job: one row per org, kept
-- for good. Stopping sets stopped_at; watching again clears it. Started from
-- the lost / cancelled / completed close-outs (ticked by default) or the org
-- page. The daily check (services/leads/band-watch.ts) asks Ticketmaster for
-- every date the band has in the UK and Europe; a tour becomes an ordinary
-- warm lead carrying watch_id.

CREATE TABLE IF NOT EXISTS band_watches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     UUID NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  -- The Ticketmaster act ("attraction") the band is checked by.
  --   pending     — not looked up yet (or Ticketmaster was unavailable)
  --   auto        — exactly one act with the same name, or a lead already had it
  --   confirmed   — a person picked it on the Leads page
  --   needs_match — none or several: on the "Match these" list
  --   not_found   — a person said it isn't on Ticketmaster
  tm_attraction_id    TEXT,
  tm_attraction_name  TEXT,
  tm_match            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (tm_match IN ('pending', 'auto', 'confirmed', 'needs_match', 'not_found')),
  tm_candidates       JSONB NOT NULL DEFAULT '[]',
  started_from_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  started_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The latest close-out (or click) that asked for it — who gets the bell.
  last_ticked_job_id  UUID REFERENCES jobs(id) ON DELETE SET NULL,
  last_ticked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  last_ticked_at      TIMESTAMPTZ,
  stopped_at          TIMESTAMPTZ,
  stopped_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  last_tm_check_at    TIMESTAMPTZ,
  last_tm_result      JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_band_watches_due
  ON band_watches (last_tm_check_at NULLS FIRST) WHERE stopped_at IS NULL;

-- A lead found (or re-found) by a watch. tour_dates holds every UK and
-- European date with its country: [{date, venue, city, country}].
-- uk_position says where the UK dates sit in that tour (spec §21.2 item 9).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS watch_id    UUID REFERENCES band_watches(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tour_dates  JSONB;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS uk_position TEXT
  CHECK (uk_position IN ('start', 'end', 'both', 'middle', 'none'));
CREATE INDEX IF NOT EXISTS idx_leads_watch ON leads (watch_id) WHERE watch_id IS NOT NULL;

-- Off switch for the daily check (the close-out tick still records watches):
--   UPDATE system_settings SET value = 'false' WHERE key = 'band_watch_enabled';
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('band_watch_enabled', 'true',
        'Check watched bands for new tours every week (Ticketmaster, UK + Europe)',
        'leads', 'bool', 90)
ON CONFLICT (key) DO NOTHING;
