-- Migration 027: Organisation Relationships & Job-Organisation Links
-- Adds org-to-org relationships (manages, books_for, etc.) and
-- multi-org links on jobs (band, client, promoter, etc.)

-- ============================================================================
-- ORGANISATION RELATIONSHIPS — Org-to-org links (Spec §2.1 extension)
-- ============================================================================
-- Enables: "Boom And Booth manages The Libertines"
-- Stored once, displayed bidirectionally (manages ↔ managed by)
CREATE TABLE IF NOT EXISTS organisation_relationships (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    to_org_id           UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    relationship_type   VARCHAR(50) NOT NULL,
    -- CHECK: manages, books_for, does_accounts_for, promotes, supplies, represents, other
    status              VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'historical')),
    start_date          DATE,
    end_date            DATE,
    notes               TEXT,
    created_by          VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    -- Prevent duplicate active relationships of same type between same orgs
    CONSTRAINT uq_org_relationship UNIQUE (from_org_id, to_org_id, relationship_type, status),
    -- Prevent self-referencing
    CONSTRAINT chk_no_self_relationship CHECK (from_org_id != to_org_id)
);

CREATE INDEX idx_org_rel_from ON organisation_relationships (from_org_id);
CREATE INDEX idx_org_rel_to ON organisation_relationships (to_org_id);
CREATE INDEX idx_org_rel_type ON organisation_relationships (relationship_type);
CREATE INDEX idx_org_rel_active ON organisation_relationships (status) WHERE status = 'active';

-- ============================================================================
-- JOB ORGANISATIONS — Multi-org links per job
-- ============================================================================
-- Enables: Job has band=The Libertines, client=Boom And Booth, promoter=Live Nation
CREATE TABLE IF NOT EXISTS job_organisations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id              UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    organisation_id     UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    role                VARCHAR(50) NOT NULL,
    -- CHECK: band, client, promoter, venue_operator, supplier, management, label, other
    is_primary          BOOLEAN DEFAULT false,
    notes               TEXT,
    created_by          VARCHAR(255) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    -- One org can't have the same role twice on the same job
    CONSTRAINT uq_job_org_role UNIQUE (job_id, organisation_id, role)
);

CREATE INDEX idx_job_org_job ON job_organisations (job_id);
CREATE INDEX idx_job_org_org ON job_organisations (organisation_id);
CREATE INDEX idx_job_org_role ON job_organisations (role);

-- ============================================================================
-- PICKLIST VALUES for the new tables
-- ============================================================================

-- Organisation relationship types
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
    ('org_relationship_type', 'manages', 'Manages', 1),
    ('org_relationship_type', 'books_for', 'Books For', 2),
    ('org_relationship_type', 'does_accounts_for', 'Does Accounts For', 3),
    ('org_relationship_type', 'promotes', 'Promotes', 4),
    ('org_relationship_type', 'supplies', 'Supplies', 5),
    ('org_relationship_type', 'represents', 'Represents', 6),
    ('org_relationship_type', 'other', 'Other', 99)
ON CONFLICT DO NOTHING;

-- Job organisation roles
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
    ('job_org_role', 'band', 'Band', 1),
    ('job_org_role', 'client', 'Client', 2),
    ('job_org_role', 'promoter', 'Promoter', 3),
    ('job_org_role', 'venue_operator', 'Venue Operator', 4),
    ('job_org_role', 'management', 'Management', 5),
    ('job_org_role', 'label', 'Label', 6),
    ('job_org_role', 'supplier', 'Supplier', 7),
    ('job_org_role', 'other', 'Other', 99)
ON CONFLICT DO NOTHING;

-- Grant permissions for backup user (consistent with other tables)
GRANT SELECT ON organisation_relationships TO PUBLIC;
GRANT SELECT ON job_organisations TO PUBLIC;
