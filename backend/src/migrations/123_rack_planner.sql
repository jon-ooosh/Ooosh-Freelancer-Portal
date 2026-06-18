-- 121_rack_planner.sql
--
-- Rack Planner — describes HOW a rack/system is supplied for a job, on top of
-- HireHop (which owns WHAT). Pull-only; never writes back to HireHop.
-- Full design: docs/RACK-PLANNER-SPEC.md.
--
-- rack_plans       — one saved plan document per job (nodes + arrows + notes),
--                    plus a login-free view token (mirrors ooh_parking_token /
--                    storage T&Cs accept-link pattern).
-- rack_stock_items — OP-owned front-panel photos keyed by HireHop LIST_ID.
--                    HireHop exposes no readable stock-item image endpoint, and
--                    we need our own rendering primitives (half-width, blanks)
--                    anyway. Lazy-seeded; back_photo reserved (no rear panels v1).

CREATE TABLE IF NOT EXISTS rack_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  hh_job_number  INTEGER,
  title          TEXT,
  view_token     TEXT NOT NULL UNIQUE,
  -- Saved layout document: { nodes: [...], arrows: [...] }. The *saved* plan;
  -- drift is computed live against jobs.line_items at load, never stored here.
  layout         JSONB NOT NULL DEFAULT '{"nodes":[],"arrows":[]}'::jsonb,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One plan per job for now (get-or-create). Drop this unique index later if
-- multiple plans per job is ever wanted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rack_plans_job ON rack_plans(job_id);
CREATE INDEX IF NOT EXISTS idx_rack_plans_token ON rack_plans(view_token);

CREATE TABLE IF NOT EXISTS rack_stock_items (
  list_id          INTEGER PRIMARY KEY,   -- HireHop stock LIST_ID (stable across jobs)
  name_cache       TEXT,
  front_photo_key  TEXT,                  -- R2 key
  back_photo_key   TEXT,                  -- reserved (v1 has no rear panels)
  updated_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backup user read grants (match the other OP tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON rack_plans TO ooosh_backup;
    GRANT SELECT ON rack_stock_items TO ooosh_backup;
  END IF;
END $$;
