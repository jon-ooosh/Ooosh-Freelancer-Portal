-- ============================================================================
-- OOOSH OPERATIONS PLATFORM — Phase 1 Foundation Schema
-- Migration 001: Core data model
-- ============================================================================
-- This schema implements the core entities from Section 2 of the spec:
-- People, Organisations, Relationships, Venues, Interactions, Users, Audit Log
-- Plus the cross-reference map for external system IDs (HireHop, Xero)
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Enable full-text search
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- PEOPLE — The central entity (Spec §2.1)
-- ============================================================================
-- Every person exists independently of any company, band, or role.
-- Personal contact details, communication preferences, and unified activity
-- timeline live here.
CREATE TABLE people (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name      VARCHAR(255) NOT NULL,
    last_name       VARCHAR(255) NOT NULL,
    email           VARCHAR(500),
    phone           VARCHAR(50),
    mobile          VARCHAR(50),
    notes           TEXT,
    tags            TEXT[] DEFAULT '{}',
    -- Communication preferences (Phase 2+)
    preferred_contact_method VARCHAR(20) DEFAULT 'email',
    -- Soft delete
    is_deleted      BOOLEAN DEFAULT false,
    -- Metadata
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for people search (fuzzy matching via trigram)
CREATE INDEX idx_people_name ON people USING gin (
    (first_name || ' ' || last_name) gin_trgm_ops
);
CREATE INDEX idx_people_email ON people (lower(email));
CREATE INDEX idx_people_tags ON people USING gin (tags);
CREATE INDEX idx_people_not_deleted ON people (is_deleted) WHERE is_deleted = false;

-- ============================================================================
-- ORGANISATIONS — Companies, bands, management firms, etc. (Spec §2.1)
-- ============================================================================
-- Typed and categorisable. Can have parent/subsidiary relationships.
CREATE TABLE organisations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(500) NOT NULL,
    type            VARCHAR(100) NOT NULL, -- band, management, label, agency, promoter, venue, festival, supplier, other
    parent_id       UUID REFERENCES organisations(id) ON DELETE SET NULL,
    website         VARCHAR(1000),
    email           VARCHAR(500),
    phone           VARCHAR(50),
    address         TEXT,
    notes           TEXT,
    tags            TEXT[] DEFAULT '{}',
    -- Soft delete
    is_deleted      BOOLEAN DEFAULT false,
    -- Metadata
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_organisations_name ON organisations USING gin (name gin_trgm_ops);
CREATE INDEX idx_organisations_type ON organisations (type);
CREATE INDEX idx_organisations_parent ON organisations (parent_id);
CREATE INDEX idx_organisations_not_deleted ON organisations (is_deleted) WHERE is_deleted = false;

-- ============================================================================
-- PERSON ↔ ORGANISATION ROLES — The critical junction table (Spec §2.2)
-- ============================================================================
-- Rich metadata: role, status, dates, primary flag, notes.
-- This is the most important data structure in the system.
-- Enables: relationship history, movement detection, multi-role tracking.
CREATE TABLE person_organisation_roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    role            VARCHAR(255) NOT NULL, -- Tour Manager, Manager, Agent, Accountant, etc.
    status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'historical')),
    is_primary      BOOLEAN DEFAULT false,
    start_date      DATE,
    end_date        DATE,
    notes           TEXT,
    -- Metadata
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_por_person ON person_organisation_roles (person_id);
CREATE INDEX idx_por_organisation ON person_organisation_roles (organisation_id);
CREATE INDEX idx_por_status ON person_organisation_roles (status);
CREATE INDEX idx_por_role ON person_organisation_roles (role);
-- Composite index for the common query: "active roles for a person"
CREATE INDEX idx_por_person_active ON person_organisation_roles (person_id, status)
    WHERE status = 'active';

-- ============================================================================
-- VENUES — First-class entities with accumulated site intelligence (Spec §2.1)
-- ============================================================================
CREATE TABLE venues (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(500) NOT NULL,
    address         TEXT,
    city            VARCHAR(255),
    postcode        VARCHAR(20),
    country         VARCHAR(100),
    latitude        DECIMAL(10, 7),
    longitude       DECIMAL(10, 7),
    -- Site intelligence — persists across all clients and jobs
    loading_bay_info TEXT,
    access_codes    TEXT,
    parking_info    TEXT,
    approach_notes  TEXT,
    general_notes   TEXT,
    tags            TEXT[] DEFAULT '{}',
    -- Soft delete
    is_deleted      BOOLEAN DEFAULT false,
    -- Metadata
    created_by      VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_venues_name ON venues USING gin (name gin_trgm_ops);
CREATE INDEX idx_venues_city ON venues (lower(city));
CREATE INDEX idx_venues_not_deleted ON venues (is_deleted) WHERE is_deleted = false;

-- ============================================================================
-- USERS — Authentication accounts (Spec §3.14)
-- ============================================================================
-- Each user links to a Person. Users are the authentication layer;
-- People are the identity layer.
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    email           VARCHAR(500) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) NOT NULL DEFAULT 'staff'
                    CHECK (role IN ('admin', 'manager', 'staff', 'warehouse', 'driver', 'freelancer', 'client')),
    is_active       BOOLEAN DEFAULT true,
    last_login      TIMESTAMPTZ,
    refresh_token   TEXT,
    -- Metadata
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (lower(email));
CREATE INDEX idx_users_person ON users (person_id);

-- ============================================================================
-- INTERACTIONS — Unified activity timeline (Spec §2.1)
-- ============================================================================
-- Every touchpoint: emails, calls, meetings, notes, @mentions.
-- Polymorphic linking to any entity.
CREATE TABLE interactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type            VARCHAR(20) NOT NULL CHECK (type IN ('note', 'email', 'call', 'meeting', 'mention')),
    content         TEXT NOT NULL,
    -- Polymorphic links (an interaction can relate to multiple entities)
    person_id       UUID REFERENCES people(id) ON DELETE SET NULL,
    organisation_id UUID REFERENCES organisations(id) ON DELETE SET NULL,
    job_id          UUID, -- FK added in Phase 2 when jobs table exists
    opportunity_id  UUID, -- FK added in Phase 2
    venue_id        UUID REFERENCES venues(id) ON DELETE SET NULL,
    -- @mentions
    mentioned_user_ids UUID[] DEFAULT '{}',
    -- Metadata
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_interactions_person ON interactions (person_id);
CREATE INDEX idx_interactions_organisation ON interactions (organisation_id);
CREATE INDEX idx_interactions_job ON interactions (job_id);
CREATE INDEX idx_interactions_venue ON interactions (venue_id);
CREATE INDEX idx_interactions_created ON interactions (created_at DESC);
CREATE INDEX idx_interactions_type ON interactions (type);

-- ============================================================================
-- AUDIT LOG — Immutable change tracking (Spec §4.3)
-- ============================================================================
-- Every create, update, and delete logged with user, timestamp, and
-- before/after values. Cannot be edited or deleted.
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         VARCHAR(255) NOT NULL,
    entity_type     VARCHAR(100) NOT NULL,
    entity_id       VARCHAR(255) NOT NULL,
    action          VARCHAR(10) NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    previous_values JSONB,
    new_values      JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Audit log is append-only. Revoke UPDATE and DELETE on this table.
-- (Applied via a separate privileges script on production.)
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_log (user_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- ============================================================================
-- CROSS-REFERENCE MAP — External system ID mapping (Spec §5)
-- ============================================================================
-- Links every entity across systems:
-- Platform Person ID ↔ HireHop Contact ID ↔ Xero Contact ID
-- Primary match key: email. Secondary: company name + person name.
CREATE TABLE external_id_map (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_type     VARCHAR(100) NOT NULL, -- people, organisations, jobs, etc.
    entity_id       UUID NOT NULL,
    external_system VARCHAR(50) NOT NULL,  -- hirehop, xero, stripe, traccar
    external_id     VARCHAR(500) NOT NULL,
    -- Metadata
    synced_at       TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    -- Prevent duplicate mappings
    UNIQUE (entity_type, entity_id, external_system)
);

CREATE INDEX idx_extmap_entity ON external_id_map (entity_type, entity_id);
CREATE INDEX idx_extmap_external ON external_id_map (external_system, external_id);

-- ============================================================================
-- NOTIFICATIONS — In-app notification queue (Spec §4.2)
-- ============================================================================
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL, -- mention, follow_up, escalation, system
    title           VARCHAR(500) NOT NULL,
    content         TEXT,
    -- Link to source entity
    entity_type     VARCHAR(100),
    entity_id       UUID,
    -- Status
    is_read         BOOLEAN DEFAULT false,
    read_at         TIMESTAMPTZ,
    -- Metadata
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications (user_id, is_read, created_at DESC);

-- ============================================================================
-- PICKLISTS — Configurable dropdown values (Spec §3.14)
-- ============================================================================
-- Manages: organisation types, relationship roles, loss reasons, etc.
-- Editable by admins without code changes.
CREATE TABLE picklist_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category        VARCHAR(100) NOT NULL, -- org_type, relationship_role, loss_reason, etc.
    value           VARCHAR(255) NOT NULL,
    label           VARCHAR(255) NOT NULL,
    sort_order      INT DEFAULT 0,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (category, value)
);

CREATE INDEX idx_picklist_category ON picklist_items (category, sort_order);

-- ============================================================================
-- SEED PICKLIST DATA
-- ============================================================================

-- Organisation types
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
    ('org_type', 'band', 'Band', 1),
    ('org_type', 'management', 'Management Company', 2),
    ('org_type', 'label', 'Record Label', 3),
    ('org_type', 'agency', 'Booking Agency', 4),
    ('org_type', 'promoter', 'Promoter', 5),
    ('org_type', 'venue', 'Venue', 6),
    ('org_type', 'festival', 'Festival', 7),
    ('org_type', 'supplier', 'Supplier', 8),
    ('org_type', 'accountancy', 'Accountancy Firm', 9),
    ('org_type', 'production', 'Production Company', 10),
    ('org_type', 'other', 'Other', 99);

-- Relationship roles
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
    ('relationship_role', 'tour_manager', 'Tour Manager', 1),
    ('relationship_role', 'manager', 'Manager', 2),
    ('relationship_role', 'agent', 'Agent', 3),
    ('relationship_role', 'accountant', 'Accountant', 4),
    ('relationship_role', 'label_rep', 'Label Rep', 5),
    ('relationship_role', 'production_manager', 'Production Manager', 6),
    ('relationship_role', 'driver', 'Driver', 7),
    ('relationship_role', 'merch_manager', 'Merch Manager', 8),
    ('relationship_role', 'site_contact', 'Site Contact', 9),
    ('relationship_role', 'band_member', 'Band Member', 10),
    ('relationship_role', 'tech', 'Tech / Crew', 11),
    ('relationship_role', 'owner', 'Owner / Director', 12),
    ('relationship_role', 'other', 'Other', 99);

-- Interaction types
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
    ('interaction_type', 'note', 'Note', 1),
    ('interaction_type', 'email', 'Email', 2),
    ('interaction_type', 'call', 'Phone Call', 3),
    ('interaction_type', 'meeting', 'Meeting', 4),
    ('interaction_type', 'mention', '@Mention', 5);
