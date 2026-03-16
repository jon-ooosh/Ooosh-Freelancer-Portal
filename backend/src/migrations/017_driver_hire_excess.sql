-- Migration 017: Driver Hire Forms & Insurance Excess
--
-- Introduces:
--   1. drivers              — Global driver records with DVLA/licence data
--   2. vehicle_hire_assignments — Unified vehicle-to-job assignment (replaces R2 allocations)
--   3. job_excess           — Insurance excess financial lifecycle tracking
--   4. excess_rules         — Configurable excess calculation rules (points tiers, referral triggers)
--   5. client_excess_ledger — View: running balance per client across all hires
--
-- See docs/DRIVER-HIRE-EXCESS-SPEC.md for full specification.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. DRIVERS TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS drivers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             UUID REFERENCES people(id),

  -- Identity
  full_name             VARCHAR(200) NOT NULL,
  email                 VARCHAR(255),
  phone                 VARCHAR(50),
  date_of_birth         DATE,
  address_line1         VARCHAR(255),
  address_line2         VARCHAR(255),
  city                  VARCHAR(100),
  postcode              VARCHAR(20),

  -- DVLA / Licence
  licence_number        VARCHAR(50),
  licence_type          VARCHAR(20),
  licence_valid_from    DATE,
  licence_valid_to      DATE,
  licence_issue_country VARCHAR(100) DEFAULT 'GB',
  licence_points        INTEGER DEFAULT 0,
  licence_endorsements  JSONB DEFAULT '[]',
  licence_restrictions  TEXT,
  dvla_check_code       VARCHAR(50),
  dvla_check_date       DATE,

  -- Insurance referral
  requires_referral     BOOLEAN DEFAULT false,
  referral_status       VARCHAR(30),
  referral_date         DATE,
  referral_notes        TEXT,

  -- Metadata
  source                VARCHAR(30) DEFAULT 'hire_form',
  monday_item_id        VARCHAR(50),
  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_drivers_person_id ON drivers(person_id);
CREATE INDEX IF NOT EXISTS idx_drivers_email ON drivers(email);
CREATE INDEX IF NOT EXISTS idx_drivers_licence ON drivers(licence_number);
CREATE INDEX IF NOT EXISTS idx_drivers_name ON drivers(full_name);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. VEHICLE HIRE ASSIGNMENTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_hire_assignments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What's assigned
  vehicle_id            UUID NOT NULL REFERENCES fleet_vehicles(id),
  job_id                UUID REFERENCES jobs(id),
  hirehop_job_id        INTEGER,
  hirehop_job_name      VARCHAR(500),

  -- Who's driving
  driver_id             UUID REFERENCES drivers(id),
  assignment_type       VARCHAR(20) NOT NULL DEFAULT 'self_drive',
  -- CHECK: self_drive | driven | delivery | collection

  -- Van requirement matching
  van_requirement_index INTEGER DEFAULT 0,
  required_type         VARCHAR(50),
  required_gearbox      VARCHAR(10),

  -- Assignment lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'soft',
  -- CHECK: soft | confirmed | booked_out | active | returned | cancelled
  status_changed_at     TIMESTAMPTZ DEFAULT NOW(),

  -- Hire dates
  hire_start            DATE,
  hire_end              DATE,
  start_time            TIME,
  end_time              TIME,
  return_overnight      BOOLEAN,

  -- Book-out data
  booked_out_at         TIMESTAMPTZ,
  booked_out_by         UUID REFERENCES users(id),
  mileage_out           INTEGER,
  fuel_level_out        VARCHAR(20),

  -- Check-in data
  checked_in_at         TIMESTAMPTZ,
  checked_in_by         UUID REFERENCES users(id),
  mileage_in            INTEGER,
  fuel_level_in         VARCHAR(20),
  has_damage            BOOLEAN DEFAULT false,

  -- Freelancer/staff driver (for 'driven' type)
  freelancer_person_id  UUID REFERENCES people(id),

  -- Metadata
  notes                 TEXT,
  ve103b_ref            VARCHAR(100),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID REFERENCES users(id),
  allocated_by_name     VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_vha_vehicle ON vehicle_hire_assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vha_job ON vehicle_hire_assignments(job_id);
CREATE INDEX IF NOT EXISTS idx_vha_hirehop_job ON vehicle_hire_assignments(hirehop_job_id);
CREATE INDEX IF NOT EXISTS idx_vha_driver ON vehicle_hire_assignments(driver_id);
CREATE INDEX IF NOT EXISTS idx_vha_status ON vehicle_hire_assignments(status);
CREATE INDEX IF NOT EXISTS idx_vha_dates ON vehicle_hire_assignments(hire_start, hire_end);
CREATE INDEX IF NOT EXISTS idx_vha_freelancer ON vehicle_hire_assignments(freelancer_person_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. JOB EXCESS TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS job_excess (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id           UUID NOT NULL REFERENCES vehicle_hire_assignments(id) ON DELETE CASCADE,
  job_id                  UUID REFERENCES jobs(id),
  hirehop_job_id          INTEGER,

  -- Excess amounts
  excess_amount_required  DECIMAL(10,2),
  excess_amount_taken     DECIMAL(10,2) DEFAULT 0,
  excess_calculation_basis TEXT,

  -- Status
  excess_status           VARCHAR(30) NOT NULL DEFAULT 'pending',
  -- CHECK: not_required | pending | taken | partial | waived | claimed | reimbursed | rolled_over

  -- Payment
  payment_method          VARCHAR(30),
  payment_reference       VARCHAR(200),
  payment_date            TIMESTAMPTZ,

  -- Xero
  xero_contact_id         VARCHAR(100),
  xero_contact_name       VARCHAR(200),
  client_name             VARCHAR(200),

  -- Claim / reimbursement
  claim_amount            DECIMAL(10,2),
  claim_date              TIMESTAMPTZ,
  claim_notes             TEXT,
  reimbursement_amount    DECIMAL(10,2),
  reimbursement_date      TIMESTAMPTZ,
  reimbursement_method    VARCHAR(30),

  -- Metadata
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  created_by              UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_excess_assignment ON job_excess(assignment_id);
CREATE INDEX IF NOT EXISTS idx_excess_job ON job_excess(job_id);
CREATE INDEX IF NOT EXISTS idx_excess_hirehop ON job_excess(hirehop_job_id);
CREATE INDEX IF NOT EXISTS idx_excess_status ON job_excess(excess_status);
CREATE INDEX IF NOT EXISTS idx_excess_xero ON job_excess(xero_contact_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. EXCESS RULES TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS excess_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type         VARCHAR(30) NOT NULL,
  condition_min     INTEGER,
  condition_max     INTEGER,
  condition_code    VARCHAR(10),
  excess_amount     DECIMAL(10,2),
  requires_referral BOOLEAN DEFAULT false,
  description       TEXT,
  is_active         BOOLEAN DEFAULT true,
  sort_order        INTEGER DEFAULT 0,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_by        UUID REFERENCES users(id)
);

-- Seed default excess rules
INSERT INTO excess_rules (rule_type, condition_min, condition_max, excess_amount, requires_referral, description, sort_order) VALUES
  ('points_tier', 0, 0, 250.00, false, 'Clean licence — standard excess', 1),
  ('points_tier', 1, 3, 500.00, false, 'Minor points (1-3) — elevated excess', 2),
  ('points_tier', 4, 6, 750.00, false, 'Moderate points (4-6) — high excess', 3),
  ('points_tier', 7, 9, 1000.00, false, 'High points (7-9) — maximum excess, may require referral', 4),
  ('points_tier', 10, 99, NULL, true, '10+ points — insurer referral required', 5),
  ('endorsement_referral', NULL, NULL, NULL, true, 'Drink/drug driving codes — insurer referral required', 10),
  ('endorsement_referral', NULL, NULL, NULL, true, 'Disqualified driver codes — insurer referral required', 11),
  ('endorsement_referral', NULL, NULL, NULL, true, 'Dangerous driving codes — insurer referral required', 12),
  ('endorsement_referral', NULL, NULL, NULL, true, 'Totting up disqualification — insurer referral required', 13),
  ('licence_type', NULL, NULL, NULL, true, 'Non-GB licence — insurer referral required', 20)
ON CONFLICT DO NOTHING;

-- Set endorsement codes on referral rules
UPDATE excess_rules SET condition_code = 'DR' WHERE description LIKE 'Drink/drug%' AND condition_code IS NULL;
UPDATE excess_rules SET condition_code = 'IN' WHERE description LIKE 'Disqualified%' AND condition_code IS NULL;
UPDATE excess_rules SET condition_code = 'DD' WHERE description LIKE 'Dangerous%' AND condition_code IS NULL;
UPDATE excess_rules SET condition_code = 'TT' WHERE description LIKE 'Totting%' AND condition_code IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. CLIENT EXCESS LEDGER VIEW
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW client_excess_ledger AS
SELECT
  xero_contact_id,
  MAX(xero_contact_name) AS xero_contact_name,
  MAX(client_name) AS client_name,
  COUNT(*) AS total_hires,
  COALESCE(SUM(excess_amount_taken), 0) AS total_taken,
  COALESCE(SUM(claim_amount), 0) AS total_claimed,
  COALESCE(SUM(reimbursement_amount), 0) AS total_reimbursed,
  COALESCE(SUM(excess_amount_taken), 0)
    - COALESCE(SUM(claim_amount), 0)
    - COALESCE(SUM(reimbursement_amount), 0) AS balance_held,
  COUNT(*) FILTER (WHERE excess_status = 'pending') AS pending_count,
  COUNT(*) FILTER (WHERE excess_status = 'taken') AS held_count,
  COUNT(*) FILTER (WHERE excess_status = 'rolled_over') AS rolled_over_count
FROM job_excess
WHERE excess_status != 'not_required'
  AND xero_contact_id IS NOT NULL
GROUP BY xero_contact_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. GRANT PERMISSIONS (for backup user if exists)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON drivers TO ooosh_backup;
    GRANT SELECT ON vehicle_hire_assignments TO ooosh_backup;
    GRANT SELECT ON job_excess TO ooosh_backup;
    GRANT SELECT ON excess_rules TO ooosh_backup;
    GRANT SELECT ON client_excess_ledger TO ooosh_backup;
  END IF;
END $$;
