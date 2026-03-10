-- Migration 003: Add job status snapshot to interactions
-- When a note/interaction is linked to a job, capture the HireHop status
-- at the time the interaction was created. This lets users track enquiry
-- progression (e.g. Provisional → Booked → Dispatched) alongside notes.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS job_status_at_creation SMALLINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS job_status_name_at_creation VARCHAR(50) DEFAULT NULL;

-- Add scheduled sync tracking
CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type VARCHAR(50) NOT NULL,  -- 'jobs', 'contacts'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed'
  result JSONB,
  triggered_by VARCHAR(50) NOT NULL DEFAULT 'manual'  -- 'manual', 'scheduled', 'auto'
);

CREATE INDEX IF NOT EXISTS idx_sync_log_type ON sync_log (sync_type, started_at DESC);
