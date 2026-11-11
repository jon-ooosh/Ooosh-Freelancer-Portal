-- 342: The Marketing page (docs/BUSINESS-FIGURES-SPEC.md §8, step 2, Nov 2026).
--
-- marketing_placements — where we advertise: a magazine issue, a directory listing, a
--   campaign. Cost, dates, the next thing due (artwork deadline, renewal — it becomes a
--   To Do for whoever set it), and whether we've had the proof / copy.
-- marketing_links — short tracked links (go.oooshtours.co.uk/<code>, also served at
--   /api/go/<code>): a scan is counted, then forwarded to the chosen page with campaign
--   tags + ol=<code>, so an enquiry from it carries the code (job_marketing_source.link_code).
--   A printed code can be repointed later; a paused or unknown code goes to the home page.
-- marketing_link_scans — one row per scan: when, and a rough device type. Nothing personal.
CREATE TABLE IF NOT EXISTS marketing_placements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR(200) NOT NULL,
  channel            VARCHAR(30) NOT NULL DEFAULT 'print'
                       CHECK (channel IN ('print', 'online', 'social', 'search_ads', 'event', 'sponsorship', 'other')),
  supplier           VARCHAR(200),
  cost               NUMERIC(12,2),
  starts_on          DATE,
  ends_on            DATE,
  next_due_on        DATE,
  next_due_note      VARCHAR(200),
  proof_received_on  DATE,
  artwork_url        TEXT,
  status             VARCHAR(20) NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'live', 'ended', 'cancelled')),
  notes              TEXT,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(60) NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]*$'),
  placement_id  UUID REFERENCES marketing_placements(id) ON DELETE SET NULL,
  label         VARCHAR(200),
  destination   TEXT NOT NULL,
  utm_source    VARCHAR(100),
  utm_medium    VARCHAR(100),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_link_scans (
  id          BIGSERIAL PRIMARY KEY,
  link_id     UUID NOT NULL REFERENCES marketing_links(id) ON DELETE CASCADE,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device      VARCHAR(10)                       -- mobile | desktop | bot
);
CREATE INDEX IF NOT EXISTS idx_marketing_link_scans_link ON marketing_link_scans (link_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_job_marketing_source_link ON job_marketing_source (link_code);
