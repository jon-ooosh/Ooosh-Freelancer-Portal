-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Migration 029: Sync Review Queue
-- ============================================================================
-- Adds a review queue for HireHop sync conflicts and data cleanup tracking.
-- Used when sync detects entities that may need manual review (e.g., contact
-- name matches an existing organisation, or type mismatch between OP and HH).
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_review_queue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type     VARCHAR(50) NOT NULL,   -- 'person', 'organisation', 'job'
    entity_id       UUID,                    -- Reference to the OP entity (nullable if not yet created)
    external_id     VARCHAR(255),            -- HireHop ID
    review_type     VARCHAR(50) NOT NULL,    -- 'type_mismatch', 'name_conflict', 'possible_band', 'convert_suggestion'
    summary         TEXT NOT NULL,            -- Human-readable description
    details         JSONB DEFAULT '{}',      -- Extra context (e.g., HH flags, current OP type, suggested type)
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'resolved', 'dismissed')),
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    resolution_note TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sync_review_status ON sync_review_queue (status);
CREATE INDEX idx_sync_review_entity ON sync_review_queue (entity_type, entity_id);

-- Grant permissions for backup user
GRANT SELECT ON sync_review_queue TO ooosh_backup;
