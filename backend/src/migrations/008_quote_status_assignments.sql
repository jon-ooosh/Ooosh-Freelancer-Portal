-- Migration 008: Quote status workflow + freelancer/crew assignments
-- Adds confirmation status to quotes and crew assignment junction table

-- ── Quote status field ──────────────────────────────────────────────────
-- Track whether a transport quote is draft, confirmed, cancelled, etc.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft'
  CHECK (status IN ('draft', 'confirmed', 'cancelled', 'completed'));
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES users(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cancelled_reason TEXT;

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS travel_time_mins INT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS travel_cost DECIMAL(12, 2);

CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status) WHERE is_deleted = false;

-- ── Quote crew assignments ──────────────────────────────────────────────
-- Links people (freelancers or internal team) to transport quotes
CREATE TABLE IF NOT EXISTS quote_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id    UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- Role on this job
  role        VARCHAR(100) NOT NULL DEFAULT 'driver',  -- driver, crew, loader, tech, manager

  -- Rate tracking (what we're paying this person for this job)
  agreed_rate       DECIMAL(12, 2),   -- Agreed fee for this person
  rate_type         VARCHAR(20),       -- 'hourly', 'dayrate', 'fixed'
  rate_notes        TEXT,              -- Any rate negotiation notes

  -- Status
  status      VARCHAR(20) DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'confirmed', 'declined', 'completed', 'cancelled')),

  -- Notes
  notes       TEXT,

  -- Audit
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate assignments
  UNIQUE (quote_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_quote_assignments_quote ON quote_assignments (quote_id);
CREATE INDEX IF NOT EXISTS idx_quote_assignments_person ON quote_assignments (person_id);
CREATE INDEX IF NOT EXISTS idx_quote_assignments_status ON quote_assignments (status)
  WHERE status IN ('assigned', 'confirmed');
