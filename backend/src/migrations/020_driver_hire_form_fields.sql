-- 020: Add hire form fields to drivers table
-- Required for Phase C: Hire Form Repointing (Monday.com → OP backend)
-- See docs/HIRE-FORM-REPOINTING-SPEC.md for full context

-- Document expiry dates (the validity backbone — drives routing engine)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa1_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa2_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS passport_valid_until DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_next_check_due DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dvla_valid_until DATE;

-- Document providers (for POA diversity check — POA1 and POA2 must differ)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa1_provider VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS poa2_provider VARCHAR(100);

-- Identity & contact gaps
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_country VARCHAR(10);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS nationality VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_issued_by VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS licence_address TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address_full TEXT;

-- Driving history
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS date_passed_test DATE;

-- Insurance questionnaire booleans
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_disability BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_convictions BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_prosecution BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_accidents BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_insurance_issues BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_driving_ban BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS additional_details TEXT;

-- Insurance & overall status
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS insurance_status VARCHAR(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS overall_status VARCHAR(50);

-- iDenfy audit trail
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS idenfy_check_date VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS idenfy_scan_ref VARCHAR(100);

-- Signature tracking
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS signature_date DATE;

-- Grant backup permissions if role exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON drivers TO ooosh_backup;
  END IF;
END $$;
