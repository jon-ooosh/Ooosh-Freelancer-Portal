-- ============================================================================
-- Migration 075: Job Issues — dedicated cross-module register
-- ============================================================================
-- Replaces the phase-1 storage on job_requirements (requirement_type='issue').
-- Promotion was always planned — the public API at /api/problems/* stays the
-- same, the storage moves underneath. Reasons for the dedicated table:
--   - Cross-job linkage (an issue against vehicle X is queryable across all
--     hires of that van without going through job_requirements + custom_label
--     parsing)
--   - First-class anchors: vehicle_id, driver_id, person_id, hh_stock_item_id,
--     client_organisation_id — typed FKs not free-text fields
--   - Structured event timeline (status changes, comments, assignments,
--     mentions, attachments) — separate child table, queryable
--   - File attachments per issue (photos of damage, quotes, invoices)
--   - Resolution path (claim_excess / charge_client / write_off / replaced)
--     and money fields (estimated_cost / actual_cost) without polluting
--     job_requirements
--   - surface_on rules — issues that re-pop up at the right moment
--     (vehicle check-in, next hire of this van, job close-out)
--
-- Migrates existing job_requirements rows where requirement_type='issue' into
-- this table at the bottom of this file. The old rows get status='cancelled'
-- + notes annotated so the audit trail survives.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Anchors. job_id is mandatory (every issue has a chargeable context).
  -- Other anchors are optional; an issue can be against just the job, or
  -- against a specific van/driver/equipment-item/person on the job.
  job_id                  UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  vehicle_id              UUID REFERENCES fleet_vehicles(id) ON DELETE SET NULL,
  driver_id               UUID REFERENCES drivers(id) ON DELETE SET NULL,
  person_id               UUID REFERENCES people(id) ON DELETE SET NULL,
  client_organisation_id  UUID REFERENCES organisations(id) ON DELETE SET NULL,
  -- HireHop equipment context. Stock item ID is the line item on the job;
  -- barcode is the actual checked-out item (typed in for v1, future: pulled
  -- from HH check-out data). Name is denormalised so we don't lose context
  -- if the HH item moves/changes later.
  hh_stock_item_id        BIGINT,
  hh_stock_item_name      VARCHAR(255),
  barcode                 VARCHAR(100),

  -- Classification
  category                VARCHAR(20) NOT NULL,
  -- 'damaged' | 'missing' | 'broken' | 'dispute' | 'breakdown' | 'other'
  source_module           VARCHAR(20) NOT NULL DEFAULT 'manual',
  -- 'manual' | 'vehicle' | 'backline' | 'transport' | 'client' | 'driver'
  severity                VARCHAR(10) NOT NULL DEFAULT 'normal',
  -- 'low' | 'normal' | 'urgent'

  -- Lifecycle
  status                  VARCHAR(20) NOT NULL DEFAULT 'open',
  -- 'open' | 'investigating' | 'awaiting_quote' | 'quoted' | 'actioned'
  -- | 'resolved' | 'written_off' | 'cancelled'
  resolution_path         VARCHAR(20),
  -- 'claim_excess' | 'charge_client' | 'write_off' | 'replaced' | 'other'

  -- Content
  summary                 VARCHAR(255) NOT NULL,
  description             TEXT,

  -- Accountability
  reported_by             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_to             UUID REFERENCES users(id) ON DELETE SET NULL,
  watchers                UUID[] NOT NULL DEFAULT '{}',
  -- mentioned-on-create + people who clicked "watch" — they get notifications

  -- Timing
  due_date                DATE,
  -- When do we need this resolved by; drives notification escalation.
  surface_on              VARCHAR(50),
  -- When should this issue re-surface in the workflow:
  --   NULL                 — just lives in the register / dashboard bucket
  --   'vehicle_check_in'   — banner on linked vehicle's next check-in
  --   'next_hire'          — banner on linked vehicle's next allocation
  --   'next_book_out'      — banner on linked vehicle's next book-out
  --   'job_close_out'      — blocks the linked job's completion until resolved

  -- Money (informational only for v1 — future wire-up to HH/Xero)
  estimated_cost          DECIMAL(10,2),
  actual_cost             DECIMAL(10,2),
  excess_id               UUID REFERENCES job_excess(id) ON DELETE SET NULL,

  -- Standard
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at             TIMESTAMPTZ,

  CONSTRAINT job_issues_severity_check
    CHECK (severity IN ('low', 'normal', 'urgent')),
  CONSTRAINT job_issues_category_check
    CHECK (category IN ('damaged', 'missing', 'broken', 'dispute', 'breakdown', 'other')),
  CONSTRAINT job_issues_status_check
    CHECK (status IN ('open', 'investigating', 'awaiting_quote', 'quoted', 'actioned', 'resolved', 'written_off', 'cancelled'))
);

-- Indexes — the queries that drive the surfaces.
CREATE INDEX IF NOT EXISTS idx_job_issues_job_id          ON job_issues(job_id);
CREATE INDEX IF NOT EXISTS idx_job_issues_vehicle_id      ON job_issues(vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_issues_driver_id       ON job_issues(driver_id)  WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_issues_person_id       ON job_issues(person_id)  WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_issues_client_org_id   ON job_issues(client_organisation_id) WHERE client_organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_issues_assigned_to     ON job_issues(assigned_to) WHERE assigned_to IS NOT NULL;
-- "Open issues, urgent first, oldest first" — the global problems page + dashboard bucket
CREATE INDEX IF NOT EXISTS idx_job_issues_open
  ON job_issues (severity DESC, created_at DESC)
  WHERE status NOT IN ('resolved', 'written_off', 'cancelled');

-- ── Event timeline ────────────────────────────────────────────────────────
-- Per-issue audit trail. Every status change, comment, assignment, mention,
-- file attach, cost estimate update gets an event. Drives the issue detail
-- page timeline and lets us compute "time-to-resolve" reports later.
CREATE TABLE IF NOT EXISTS job_issue_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID NOT NULL REFERENCES job_issues(id) ON DELETE CASCADE,
  event_type  VARCHAR(30) NOT NULL,
  -- 'created' | 'comment' | 'status_change' | 'assignment' | 'watchers_change'
  -- | 'mention' | 'due_date_change' | 'cost_estimate' | 'cost_actual'
  -- | 'photo_added' | 'file_added' | 'resolved' | 'reopened' | 'severity_change'
  body        TEXT,
  -- Free text. For comments: the comment body. For status_change: optional
  -- explanatory note. NULL for purely-structural events.
  metadata    JSONB,
  -- {from_status: 'open', to_status: 'investigating', from_assignee: '...', etc.}
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_issue_events_issue_id
  ON job_issue_events(issue_id, created_at DESC);

-- ── File attachments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_issue_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID NOT NULL REFERENCES job_issues(id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL,
  filename    VARCHAR(255),
  file_type   VARCHAR(50),
  -- 'photo' | 'quote_pdf' | 'invoice' | 'other'
  content_type VARCHAR(100),
  size_bytes  BIGINT,
  comment     TEXT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_issue_files_issue_id ON job_issue_files(issue_id);

-- ── Migrate existing phase-1 issue rows ───────────────────────────────────
-- Phase 1 stored issues as job_requirements rows with requirement_type='issue'.
-- Copy them into job_issues, preserving timestamps + creator + category +
-- severity. Then mark the originals 'cancelled' with an annotation so the
-- audit trail survives if anyone goes hunting.
INSERT INTO job_issues (
  id, job_id, category, source_module, severity, status,
  summary, description, reported_by, created_at, updated_at
)
SELECT
  jr.id,                                              -- preserve UUID for stable URLs
  jr.job_id,
  COALESCE(jr.issue_category, 'other'),               -- fallback for legacy rows
  COALESCE(jr.source_module, 'manual'),
  COALESCE(jr.severity, 'normal'),
  CASE
    WHEN jr.status = 'not_started' THEN 'open'
    WHEN jr.status = 'in_progress' THEN 'investigating'
    WHEN jr.status = 'blocked'     THEN 'awaiting_quote'
    WHEN jr.status = 'done'        THEN 'resolved'
    WHEN jr.status = 'cancelled'   THEN 'cancelled'
    ELSE 'open'
  END,
  COALESCE(NULLIF(jr.custom_label, ''), 'Issue'),     -- summary required, default if blank
  jr.notes,
  COALESCE(jr.created_by, '00000000-0000-0000-0000-000000000000'::uuid),
  jr.created_at,
  jr.updated_at
FROM job_requirements jr
WHERE jr.requirement_type = 'issue'
  AND NOT EXISTS (SELECT 1 FROM job_issues ji WHERE ji.id = jr.id);

-- Synthesise a 'created' event for each migrated issue so the timeline isn't
-- empty. created_by + created_at copied from the source.
INSERT INTO job_issue_events (issue_id, event_type, body, created_by, created_at)
SELECT
  ji.id,
  'created',
  '[Migrated from phase-1 problems register]',
  ji.reported_by,
  ji.created_at
FROM job_issues ji
WHERE EXISTS (
  SELECT 1 FROM job_requirements jr
  WHERE jr.id = ji.id AND jr.requirement_type = 'issue'
)
AND NOT EXISTS (
  SELECT 1 FROM job_issue_events e WHERE e.issue_id = ji.id AND e.event_type = 'created'
);

-- Mark the source job_requirements rows as cancelled so they stop appearing
-- in any phase-1 query path. Audit annotation in notes preserves the trail.
UPDATE job_requirements
SET status = 'cancelled',
    notes = COALESCE(notes, '') ||
            CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE E'\n' END ||
            '[Migrated to job_issues table on ' || NOW()::date || ']',
    updated_at = NOW()
WHERE requirement_type = 'issue'
  AND status NOT IN ('cancelled');
