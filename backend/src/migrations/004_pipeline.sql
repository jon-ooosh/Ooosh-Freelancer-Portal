-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Phase 2: Enquiry & Sales Pipeline
-- Migration 004: Pipeline fields on jobs, chase interaction type
-- ============================================================================
-- Adds pipeline status tracking, chase management, and sales fields to jobs.
-- Makes hh_job_number nullable so Ooosh-native enquiries can exist before HH.
-- Adds 'chase' interaction type and chase-specific fields on interactions.
-- ============================================================================

-- ============================================================================
-- 1. Make hh_job_number nullable (allow Ooosh-native enquiries)
-- ============================================================================
ALTER TABLE jobs ALTER COLUMN hh_job_number DROP NOT NULL;

-- ============================================================================
-- 2. Add pipeline fields to jobs table
-- ============================================================================

-- Pipeline status & tracking
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pipeline_status VARCHAR(30) DEFAULT 'new_enquiry';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pipeline_status_changed_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quote_status VARCHAR(30);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS likelihood VARCHAR(10);

-- Chase tracking
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS chase_count INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_chased_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_chase_date DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS chase_interval_days INTEGER DEFAULT 3;

-- Pause/hold context
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hold_reason VARCHAR(50);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hold_reason_detail TEXT;

-- Confirmation
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS confirmed_method VARCHAR(30);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- Financial (from HireHop MONEY field or manual entry)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_value DECIMAL(12,2);

-- Lost (basic — full win/loss system built separately)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(50);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lost_detail TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ;

-- Source tracking
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS enquiry_source VARCHAR(30);

-- HireHop status stored separately from pipeline_status for conflict detection
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hh_status SMALLINT;

-- ============================================================================
-- 3. Indexes for pipeline queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_status ON jobs (pipeline_status);
CREATE INDEX IF NOT EXISTS idx_jobs_next_chase_date ON jobs (next_chase_date) WHERE next_chase_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_likelihood ON jobs (likelihood) WHERE likelihood IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline_value ON jobs (pipeline_status, job_value) WHERE pipeline_status NOT IN ('confirmed', 'lost');

-- ============================================================================
-- 4. Add chase interaction type and chase-specific fields on interactions
-- ============================================================================

-- Add chase to picklist (interaction types)
INSERT INTO picklist_items (category, value, label, sort_order)
VALUES ('interaction_type', 'chase', 'Chase', 6)
ON CONFLICT DO NOTHING;

-- Add status_transition type for logging pipeline status changes
INSERT INTO picklist_items (category, value, label, sort_order)
VALUES ('interaction_type', 'status_transition', 'Status Change', 7)
ON CONFLICT DO NOTHING;

-- Chase-specific fields on interactions
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS chase_method VARCHAR(20);  -- phone, email, text, whatsapp
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS chase_response TEXT;        -- Quick summary of response

-- Pipeline status snapshot (what pipeline_status was when interaction created)
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS pipeline_status_at_creation VARCHAR(30);

-- ============================================================================
-- 5. Set defaults for existing jobs
-- ============================================================================

-- All existing jobs get pipeline_status based on their HH status
UPDATE jobs SET
  pipeline_status = CASE
    WHEN status = 0 THEN 'new_enquiry'
    WHEN status = 1 THEN 'provisional'
    WHEN status = 2 THEN 'confirmed'
    WHEN status BETWEEN 3 AND 8 THEN 'confirmed'
    WHEN status = 9 THEN 'lost'
    WHEN status = 10 THEN 'lost'
    WHEN status = 11 THEN 'confirmed'
    ELSE 'new_enquiry'
  END,
  pipeline_status_changed_at = NOW(),
  hh_status = status
WHERE pipeline_status IS NULL OR pipeline_status = 'new_enquiry';
