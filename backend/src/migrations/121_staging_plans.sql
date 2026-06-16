-- Migration 121: Staging Calculator plans
--
-- The Staging Calculator (ported from ooosh-utilities into OP, Jun 2026) pushes
-- calculated staging parts to a HireHop job and generates a 3D viewer link.
-- Historically that link encoded the entire stage config in the URL (huge + ugly).
-- Now that OP has a database we store the config here and mint a short slug; the
-- 3D viewer resolves the slug to the config. One row per "push" — a job can have
-- several (re-calculated stages) so the Staging tab lists them most-recent-first.
--
-- The tab only appears on Job Detail once a row exists for that job; deleting the
-- last row removes the tab (hard delete — this is a disposable calc artefact, not
-- a hire-tracking record, so the soft-cancel convention doesn't apply).

CREATE TABLE IF NOT EXISTS staging_plans (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID REFERENCES jobs(id) ON DELETE CASCADE,
  hh_job_number          INTEGER,
  slug                   TEXT NOT NULL UNIQUE,           -- short id used in the 3D viewer URL (?p=<slug>)
  stage_config           JSONB NOT NULL,                 -- the compact config the 3D viewer renders
  summary                TEXT,                           -- human-readable stage description (e.g. "16ft × 8ft @ 2ft high")
  three_d_url            TEXT,                           -- the short share URL (/stage-view.html?p=<slug>)
  share_with_freelancer  BOOLEAN NOT NULL DEFAULT FALSE, -- mirrors the files-to-share methodology
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staging_plans_job_id ON staging_plans(job_id);
CREATE INDEX IF NOT EXISTS idx_staging_plans_hh_job ON staging_plans(hh_job_number);
