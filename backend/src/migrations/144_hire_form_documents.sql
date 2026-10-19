-- 144_hire_form_documents.sql
--
-- Per-(driver, van) hire agreement PDFs for multi-van hires.
--
-- The existing vehicle_hire_assignments.hire_form_pdf_key /
-- hire_form_emailed_at columns track a driver's OWN-van agreement (one per
-- assignment row, generated + emailed at that van's book-out).
--
-- On a multi-van hire, "everyone drives everything" means each self-drive
-- driver also needs a hire agreement for every OTHER van on the job — proof
-- of eligibility for whichever van they actually drive. Those cross-van PDFs
-- are tracked here, one row per (driver assignment, van), generated + emailed
-- at each van's book-out.
--
-- Also a queryable record of who was authorised to drive which van on which
-- job (e.g. for the PCN module — "which driver could have been in this van").
--
-- The UNIQUE(assignment_id, vehicle_id) constraint is the idempotency guard:
-- it atomically serialises concurrent book-out hooks for the same van so a
-- driver never receives the same van's agreement twice.

CREATE TABLE IF NOT EXISTS hire_form_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   UUID NOT NULL REFERENCES vehicle_hire_assignments(id) ON DELETE CASCADE,
  driver_id       UUID REFERENCES drivers(id) ON DELETE SET NULL,
  job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  hirehop_job_id  INTEGER,
  vehicle_id      UUID REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  vehicle_reg     TEXT,
  pdf_r2_key      TEXT,
  email_to        TEXT,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  emailed_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (assignment_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS idx_hire_form_documents_job ON hire_form_documents(job_id);
CREATE INDEX IF NOT EXISTS idx_hire_form_documents_hh_job ON hire_form_documents(hirehop_job_id);
CREATE INDEX IF NOT EXISTS idx_hire_form_documents_driver ON hire_form_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_hire_form_documents_vehicle ON hire_form_documents(vehicle_id);
