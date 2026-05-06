-- ============================================================================
-- Migration 074: Issues / Problems Register
-- ============================================================================
-- Cross-module register for "things that need a human to chase but aren't part
-- of the normal pre-hire / post-hire flow" — vehicle damage, missing items,
-- breakdowns, client disputes. Built on the existing job_requirements table
-- so we inherit chase dates, notes, status workflow, activity log, dashboard
-- surfacing for free.
--
-- Storage shape is `requirement_type='issue'` rows on `job_requirements`,
-- with two extra columns describing the kind and urgency of the issue.
-- Storage may move to a dedicated job_issues table later (cross-job linkage,
-- equipment FK, structured event history) — the public surface lives at
-- /api/issues/* so callers don't see the move.
--
-- Categories follow distinct resolution paths. See CLAUDE.md "Issues
-- register" section for the full state machines per category. Storage is
-- a single `status` text column; the path is enforced by the route layer.
-- ============================================================================

-- 1. Register the new requirement type.
INSERT INTO requirement_type_definitions (type, label, icon, steps, sort_order) VALUES
  ('issue', 'Issue', '⚠️', NULL, 300)
ON CONFLICT (type) DO NOTHING;

-- 2. Issue-specific columns on job_requirements. NULL for non-issue rows.
ALTER TABLE job_requirements
  ADD COLUMN IF NOT EXISTS issue_category VARCHAR(20),
  ADD COLUMN IF NOT EXISTS severity VARCHAR(10) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS source_module VARCHAR(20);
-- issue_category: 'damaged' | 'missing' | 'broken' | 'dispute' | 'other'
-- severity:       'normal' | 'urgent'  (urgent → immediate notification)
-- source_module:  'vehicle' | 'backline' | 'transport' | 'manual' | NULL
--                 (where the issue was logged from — drives reporting later)

-- Constraint: severity must be one of the allowed values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'job_requirements_severity_check'
  ) THEN
    ALTER TABLE job_requirements
      ADD CONSTRAINT job_requirements_severity_check
      CHECK (severity IN ('normal', 'urgent'));
  END IF;
END $$;

-- 3. Index for the global Problems page + NeedsAttention bucket.
-- Targets the "open issues, sorted by severity then age" query path.
CREATE INDEX IF NOT EXISTS idx_job_requirements_open_issues
  ON job_requirements (severity DESC, created_at DESC)
  WHERE requirement_type = 'issue' AND status NOT IN ('done', 'cancelled');
