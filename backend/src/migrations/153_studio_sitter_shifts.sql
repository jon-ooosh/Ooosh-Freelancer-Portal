-- ============================================================================
-- 153: Studio Sitter shifts + assignments (Rehearsals module, Phase B)
-- ============================================================================
-- The assignment unit is a SITE-EVENING, not a job-room-day: one premises, one
-- sitter per evening even if both rooms are busy (the sitter looks after the
-- band(s) AND locks up the building). So a shift is keyed by calendar DATE and
-- shared across every rehearsal job running that night. See docs/REHEARSALS-SPEC.md.
--
-- Which evenings need cover is DERIVED at read-time from each job's
-- hh_derived_flags.rehearsal_detail (Phase A) — not stored here. This table only
-- holds the shift's assignment + lifecycle + any manual (daytime) override.
-- ============================================================================

CREATE TABLE IF NOT EXISTS studio_sitter_shifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One shift per calendar evening (single premises). UNIQUE is the mechanism
  -- that makes two-rooms-same-night jobs share one shift + one sitter.
  shift_date      DATE NOT NULL UNIQUE,
  planned_start   TIME,                         -- envelope (earliest needed across rooms)
  planned_end     TIME,                         -- envelope (latest needed)
  status          VARCHAR(20) NOT NULL DEFAULT 'needed'
                    CHECK (status IN ('needed','assigned','confirmed','covered','closed','cancelled')),
  -- true = staff forced cover on a day that wasn't auto-flagged (e.g. a daytime
  -- shift on a short-staffed weekend). Such a date won't be in the derived
  -- needed-set, so the roster unions existing shift rows to keep it visible.
  manual_override BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_sitter_shifts_date ON studio_sitter_shifts(shift_date);

CREATE TABLE IF NOT EXISTS studio_sitter_shift_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        UUID NOT NULL REFERENCES studio_sitter_shifts(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES people(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'assigned'
                    CHECK (status IN ('assigned','confirmed','declined','cancelled')),
  assigned_by     UUID REFERENCES users(id),
  confirmed_at    TIMESTAMPTZ,
  fee             NUMERIC(10,2),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sss_assignments_shift  ON studio_sitter_shift_assignments(shift_id);
CREATE INDEX IF NOT EXISTS idx_sss_assignments_person ON studio_sitter_shift_assignments(person_id);

-- At most one live (assigned/confirmed) assignment per shift = one sitter.
-- Reassignment cancels the old row then inserts the new one (keeps decline/
-- history audit), so this never blocks a legitimate reassign.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sss_one_active_assignment
  ON studio_sitter_shift_assignments(shift_id)
  WHERE status IN ('assigned','confirmed');

-- Grant permissions for backup user (skip if role doesn't exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON studio_sitter_shifts TO ooosh_backup;
    GRANT SELECT ON studio_sitter_shift_assignments TO ooosh_backup;
  END IF;
END $$;
