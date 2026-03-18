-- 024: Hire form PDF generation support
-- Adds columns to vehicle_hire_assignments for tracking generated hire form PDFs

ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS hire_form_pdf_key VARCHAR(500);
ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS hire_form_generated_at TIMESTAMPTZ;
ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS hire_form_emailed_at TIMESTAMPTZ;
ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS client_email VARCHAR(255);

-- Grant backup permissions if role exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON vehicle_hire_assignments TO ooosh_backup;
  END IF;
END $$;
