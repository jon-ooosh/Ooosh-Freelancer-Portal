-- Migration 086: job_contacts junction (per-job contact selection)
-- ------------------------------------------------------------------------
-- Bridges "who is at this organisation" (person_organisation_roles —
-- org-wide) with "who is involved in THIS hire" (this table — job-wide).
--
-- Why a new table rather than reusing person_organisation_roles.is_primary:
-- `is_primary` is org-wide. Sarah being primary at ATC Live means she's
-- the primary on every job for ATC Live. We need per-job selection:
-- some hires have Sarah as lead; others have Tom; some have both ticked
-- with Sarah as lead. The new junction lets that vary independently per
-- job without polluting the org-level "who's the main rep here" signal.
--
-- Phase 4 will read this table in the sender helpers (booking confirms,
-- payment receipts, hire-form requests, etc.) — the routing layer asks
-- "who's on this job" via job_contacts first, falls back to org-level
-- people via person_organisation_roles, then info@ via the safety net.
-- This migration only adds the storage; routing graduation comes next.
--
-- `role_override` is reserved for the edge case where a person's
-- per-job role differs from their org-level role (e.g. Production Manager
-- who tour-manages this one specific tour). NULL = inherit from
-- person_organisation_roles. Most rows leave it NULL.
-- ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role_override   VARCHAR(255),
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One person can't be on the same job twice
  CONSTRAINT uq_job_contact UNIQUE (job_id, person_id)
);

-- At most one primary contact per job. Partial unique index — only enforces
-- when is_primary=true, so unticked rows don't fight each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_primary_contact
  ON job_contacts (job_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_job_contacts_job ON job_contacts (job_id);
CREATE INDEX IF NOT EXISTS idx_job_contacts_person ON job_contacts (person_id);

-- updated_at trigger (matches the pattern used elsewhere in the schema)
CREATE OR REPLACE FUNCTION trigger_set_job_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_job_contacts_updated_at ON job_contacts;
CREATE TRIGGER set_job_contacts_updated_at
  BEFORE UPDATE ON job_contacts
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_job_contacts_updated_at();
