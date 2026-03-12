-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Phase 2: Jobs
-- Migration 002: Jobs table + FK on interactions.job_id
-- ============================================================================
-- Stores jobs synced from HireHop. Read-only pull for now.
-- Links to organisations (client) and venues via existing tables.
-- HireHop job number stored as hh_job_number for direct reference.
-- ============================================================================

-- ============================================================================
-- JOBS — Synced from HireHop (Spec §Phase 2)
-- ============================================================================
CREATE TABLE jobs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- HireHop reference
    hh_job_number       INTEGER NOT NULL UNIQUE,  -- HireHop job ID/number
    -- Core info
    job_name            VARCHAR(500),
    job_type            VARCHAR(255),
    status              SMALLINT NOT NULL DEFAULT 0,  -- HireHop status code (0-11)
    status_name         VARCHAR(50),                  -- Human-readable status
    colour              VARCHAR(7),                   -- HireHop hex colour
    -- Client
    client_id           UUID REFERENCES organisations(id) ON DELETE SET NULL,
    client_name         VARCHAR(500),         -- Denormalised from HH for display
    company_name        VARCHAR(500),         -- HH COMPANY field
    client_ref          VARCHAR(255),         -- Client's own reference
    -- Venue / delivery
    venue_id            UUID REFERENCES venues(id) ON DELETE SET NULL,
    venue_name          VARCHAR(500),         -- Denormalised from HH
    address             TEXT,                 -- Job/delivery address
    -- Dates (stored as-is from HireHop, no timezone conversion)
    out_date            TIMESTAMPTZ,          -- Equipment reserved from
    job_date            TIMESTAMPTZ,          -- Job starts charging
    job_end             TIMESTAMPTZ,          -- Job ends
    return_date         TIMESTAMPTZ,          -- Equipment available again
    created_date        TIMESTAMPTZ,          -- When created in HireHop
    -- Duration
    duration_days       INTEGER,
    duration_hrs        INTEGER,
    -- Managers (names from HH, linked to people where possible)
    manager1_name       VARCHAR(255),
    manager1_person_id  UUID REFERENCES people(id) ON DELETE SET NULL,
    manager2_name       VARCHAR(255),
    manager2_person_id  UUID REFERENCES people(id) ON DELETE SET NULL,
    -- Project grouping
    hh_project_id       INTEGER,
    project_name        VARCHAR(500),
    -- Details
    details             TEXT,                 -- Job memo
    custom_index        VARCHAR(500),         -- HH custom indexable field
    depot_name          VARCHAR(255),
    -- Flags
    is_internal         BOOLEAN DEFAULT false,
    -- Metadata
    notes               TEXT,
    tags                TEXT[] DEFAULT '{}',
    files               JSONB DEFAULT '[]',
    is_deleted          BOOLEAN DEFAULT false,
    created_by          VARCHAR(255) NOT NULL DEFAULT 'hirehop_sync',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_jobs_status ON jobs (status);
CREATE INDEX idx_jobs_client ON jobs (client_id);
CREATE INDEX idx_jobs_venue ON jobs (venue_id);
CREATE INDEX idx_jobs_job_date ON jobs (job_date);
CREATE INDEX idx_jobs_return_date ON jobs (return_date);
CREATE INDEX idx_jobs_manager1 ON jobs (manager1_person_id);
CREATE INDEX idx_jobs_manager2 ON jobs (manager2_person_id);
CREATE INDEX idx_jobs_project ON jobs (hh_project_id);
CREATE INDEX idx_jobs_not_deleted ON jobs (is_deleted) WHERE is_deleted = false;
CREATE INDEX idx_jobs_name ON jobs USING gin (job_name gin_trgm_ops);
-- Active jobs quick lookup (statuses 0-8)
CREATE INDEX idx_jobs_active ON jobs (status, job_date)
    WHERE status BETWEEN 0 AND 8;

-- ============================================================================
-- FK: interactions.job_id → jobs.id
-- ============================================================================
-- The job_id column already exists from 001, just add the FK constraint
ALTER TABLE interactions
    ADD CONSTRAINT fk_interactions_job
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;

-- ============================================================================
-- Add jobs to the drop script (for development resets)
-- ============================================================================
-- Note: When resetting, drop jobs BEFORE interactions due to FK
