-- ============================================================================
-- 057: Platform Issues Tracker
--
-- Lightweight internal tracker for staff to log bugs, feature requests,
-- questions, and known roadmap items against the Ooosh Operations Platform.
--
-- Sits under Operations → Issues. Any authenticated staff member can log
-- an issue; admins/managers triage status. On create, an email alert goes
-- to jon@oooshtours.co.uk so nothing falls through the cracks while the
-- platform is bedding in.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_issues (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               VARCHAR(300) NOT NULL,
  description         TEXT,
  category            VARCHAR(30) NOT NULL DEFAULT 'bug'
    CHECK (category IN ('bug', 'feature_request', 'question', 'roadmap', 'other')),
  severity            VARCHAR(10) NOT NULL DEFAULT 'normal'
    CHECK (severity IN ('low', 'normal', 'high', 'urgent')),
  status              VARCHAR(20) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'seen', 'in_progress', 'done', 'deferred', 'wont_fix')),
  area                VARCHAR(50),                -- e.g. 'money', 'vehicles', 'portal', 'pipeline'
  page_url            TEXT,                       -- where the issue was seen (optional)
  created_by          UUID REFERENCES users(id),
  assigned_to         UUID REFERENCES users(id),
  resolution_notes    TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_issues_status
  ON platform_issues (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_issues_created_by
  ON platform_issues (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_issues_area
  ON platform_issues (area) WHERE area IS NOT NULL;

-- Comments / progress notes on an issue. Anyone can add comments;
-- used to log repro steps, workarounds, "+1 saw this too", fix commits, etc.
CREATE TABLE IF NOT EXISTS platform_issue_comments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id            UUID NOT NULL REFERENCES platform_issues(id) ON DELETE CASCADE,
  author_id           UUID REFERENCES users(id),
  body                TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_issue_comments_issue
  ON platform_issue_comments (issue_id, created_at ASC);

-- Bump updated_at on row update
CREATE OR REPLACE FUNCTION platform_issues_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_issues_updated_at ON platform_issues;
CREATE TRIGGER trg_platform_issues_updated_at
  BEFORE UPDATE ON platform_issues
  FOR EACH ROW EXECUTE FUNCTION platform_issues_touch_updated_at();
