-- 316: Job projects — "all of these jobs belong to the same overall thing"
-- (docs/JOB-PROJECTS-SPEC.md). A festival: the core backline, an outlier stage,
-- a small PA and a dozen band spot-hires, each an ordinary job.
--
-- Deliberately NOT a job_groups row (kind 'part_of'): every read path on
-- job_groups assumes alternatives (pick ONE) — the portal refusal, the headline
-- dedup, the confirm bells. A project has its own table and column, so one job
-- can be an option in a group AND part of a project.
--
-- Not to be confused with jobs.hh_project_id / jobs.project_name (migration
-- 002): HireHop's own projects, never filled — the sync skips them.

CREATE TABLE IF NOT EXISTS job_projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(200) NOT NULL,
  -- The festival / organiser. Member jobs may have other clients (a band).
  client_id     UUID REFERENCES organisations(id) ON DELETE SET NULL,
  -- The lead Ooosh-er — who owns the project as a whole.
  lead_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Default dates for a NEW job in the project only. Never pushed into the
  -- existing jobs: Start/End are what HireHop charges for (spec §3).
  out_date      DATE,
  job_date      DATE,
  job_end       DATE,
  return_date   DATE,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_projects_name ON job_projects (LOWER(name));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS job_project_id UUID REFERENCES job_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_job_project ON jobs (job_project_id) WHERE job_project_id IS NOT NULL;

COMMENT ON TABLE job_projects IS
  'Jobs that belong to the same overall thing (a festival). Its own layer, not job_groups — see docs/JOB-PROJECTS-SPEC.md.';
