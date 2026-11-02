-- ============================================================================
-- 279: Leads — jobs that belong to a lead's tour
-- ============================================================================
-- Spec: docs/TOUR-FINDER-SPEC.md §19.
--
-- A lead often turns out to be a tour we've ALREADY quoted, booked or lost.
-- lead_tour_jobs links the lead to those jobs (dates within 14 days either side
-- of the tour — bands start/finish in the UK around EU legs):
--   status 'linked'    — shown as the tour's job; an open/booked one moves the
--                        lead to In pipeline (routes/leads.ts STAGE_SQL).
--   status 'suggested' — only a job NAMED after the band matched; staff confirm.
--   status 'rejected'  — staff unlinked it; never re-linked automatically.
-- link_type: 'auto' (band org matched + dates overlap), 'name' (job name only),
-- 'manual' (staff linked it by job number).
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_tour_jobs (
  lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'linked' CHECK (status IN ('linked', 'suggested', 'rejected')),
  link_type  TEXT NOT NULL DEFAULT 'auto' CHECK (link_type IN ('auto', 'name', 'manual')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lead_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_tour_jobs_job ON lead_tour_jobs (job_id);
