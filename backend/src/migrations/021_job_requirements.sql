-- Migration 021: Job Requirements System
-- Foundation for the Prep Checklist — tracks what needs to happen before a job can go out.

-- Requirement types with their own status flows
CREATE TABLE IF NOT EXISTS requirement_type_definitions (
  type VARCHAR(50) PRIMARY KEY,
  label VARCHAR(100) NOT NULL,
  icon VARCHAR(10) DEFAULT '',
  -- If steps is non-null, this is a multi-step requirement with its own flow
  -- Steps are ordered JSON array of step labels, e.g. '["Applied","Received","Items listed","Stamped out"]'
  steps JSONB DEFAULT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the default requirement types
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('transport',     'Transport / Delivery',  '🚛', NULL, 10),
  ('crew',          'Crew',                  '👥', NULL, 20),
  ('vehicle',       'Vehicle (Self-Drive)',  '🚐', NULL, 30),
  ('hire_forms',    'Driver Hire Forms',     '📋', NULL, 40),
  ('excess',        'Insurance Excess',      '💰', NULL, 50),
  ('backline',      'Backline',              '🎸', NULL, 60),
  ('merch',         'Merch Receiving',       '📦', '["Request sent","Some received","All received","Notified client","Given to client"]', 70),
  ('carnet',        'Carnet',                '📄', '["Applied","Received","Items listed","Stamped out","Returned","Closed"]', 80),
  ('rehearsal',     'Rehearsal Space',       '🎵', '["Sourcing","Booked","Confirmed with client"]', 90),
  ('accommodation', 'Accommodation',         '🏨', '["Sourcing","Booked","Confirmed"]', 100),
  ('permits',       'Special Permits',       '📑', NULL, 110),
  ('stage_plot',    'Stage Plot / Tech Spec','📐', '["Requested","Received","Reviewed"]', 120),
  ('sub_hire',      'Sub-Hire',              '🔧', '["Need identified","Sourcing","Ordered","Received","Returned"]', 130),
  ('custom',        'Custom',                '📝', NULL, 999)
ON CONFLICT (type) DO NOTHING;

-- Job requirement templates (one-click bundles)
CREATE TABLE IF NOT EXISTS requirement_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  -- Array of requirement type keys to add
  requirement_types JSONB NOT NULL DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default templates
INSERT INTO requirement_templates (name, description, requirement_types, sort_order) VALUES
  ('Self-Drive Van Hire', 'Vehicle assignment, hire forms, and insurance excess', '["vehicle","hire_forms","excess"]', 10),
  ('Crewed Delivery', 'Transport with crew and vehicle', '["transport","crew","vehicle"]', 20),
  ('Festival w/ Backline', 'Full festival support with backline and stage plot', '["transport","crew","backline","stage_plot","merch"]', 30),
  ('Tour Support', 'Tour with transport, crew, backline and accommodation', '["transport","crew","backline","accommodation"]', 40);

-- The actual per-job requirements
CREATE TABLE IF NOT EXISTS job_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  requirement_type VARCHAR(50) NOT NULL REFERENCES requirement_type_definitions(type),

  -- Status: non-linear, any status to any status
  status VARCHAR(30) NOT NULL DEFAULT 'not_started',
  -- For multi-step requirements, which step we're on (must be one of the steps in the type definition)
  current_step VARCHAR(100),

  -- Custom label (overrides type definition label if set)
  custom_label VARCHAR(255),
  notes TEXT,

  -- Who's responsible
  assigned_to UUID REFERENCES users(id),
  due_date DATE,

  -- Auto-generated vs manual
  is_auto BOOLEAN DEFAULT false,
  -- What generated this (e.g. 'quote', 'vehicle_assignment', 'template', 'manual')
  source VARCHAR(50) DEFAULT 'manual',
  -- Optional FK to the source record (quote_id, assignment_id, etc.)
  source_id UUID,

  sort_order INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate requirement types per job (one transport, one crew, etc.)
  -- Custom type can have multiples so we don't enforce uniqueness on it
  CONSTRAINT unique_requirement_per_job UNIQUE (job_id, requirement_type)
    DEFERRABLE INITIALLY DEFERRED
);

-- Allow multiple custom requirements per job by making the constraint deferred
-- and handling it in application logic (custom types skip the check)

CREATE INDEX IF NOT EXISTS idx_job_requirements_job_id ON job_requirements(job_id);
CREATE INDEX IF NOT EXISTS idx_job_requirements_status ON job_requirements(status);
CREATE INDEX IF NOT EXISTS idx_job_requirements_type ON job_requirements(requirement_type);
CREATE INDEX IF NOT EXISTS idx_job_requirements_assigned ON job_requirements(assigned_to);
CREATE INDEX IF NOT EXISTS idx_job_requirements_due_date ON job_requirements(due_date);

-- Grant permissions for backup user (skip if role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON requirement_type_definitions TO ooosh_backup;
    GRANT SELECT ON requirement_templates TO ooosh_backup;
    GRANT SELECT ON job_requirements TO ooosh_backup;
  END IF;
END $$;
