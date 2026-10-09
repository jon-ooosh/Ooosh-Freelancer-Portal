-- ============================================================================
-- 206: Staff Calendar & Time — Phase A (employment, working patterns, exceptions)
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md. Phase A is the foundation the rest sits on:
-- who the staff are, what hours they are contracted to work, and the one-off
-- deviations from that. No leave, no ledger, no absence yet — those are B/C/D.
--
-- THE LOAD-BEARING DECISIONS (spec §0), restated here because they constrain
-- every column below:
--
--   * Minutes are the only stored unit. Days and hours are display-only.
--     One member of staff works four days of UNEQUAL length (7h30 / 7h30 /
--     9h15 / 10h30), so "a day" is not a fixed quantity and must never be
--     assumed to be one.
--
--   * Working patterns are EFFECTIVE-DATED. Changing someone's hours closes
--     the current row and opens a new one; it never edits in place. Otherwise
--     every historical calendar retroactively lies the day someone's hours
--     change, and (from Phase B) past balance maths silently breaks.
--
-- Most of the employee record already lives on `people` (date_of_birth,
-- home_address, emergency contacts, licence fields, DVLA check date, passport
-- expiry, files). This migration deliberately does NOT duplicate any of it —
-- it adds only what genuinely has no home yet.
-- ============================================================================

-- ── people: the gaps in the existing employee record ────────────────────────
-- Emergency contacts already exist (mig 001) and are already written by the
-- freelancer apply flow (routes/freelancers.ts). They just lack a relationship
-- and a second contact.
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_relationship   TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_name         VARCHAR(255);
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_phone        VARCHAR(50);
ALTER TABLE people ADD COLUMN IF NOT EXISTS emergency_contact_2_relationship TEXT;

-- Right to work. Legally required to hold and produce on request; nothing in
-- the schema covered it. rtw_expires_on joins the existing document-expiry
-- scanner alongside licence_expiry / passport_expiry, so time-limited leave
-- to remain chases itself.
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_checked_on    DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_document_type VARCHAR(50);
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_expires_on    DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS rtw_checked_by    UUID REFERENCES users(id);

-- NI number is identity PII: ENCRYPTED at rest via services/encryption.ts, the
-- same treatment driver licence numbers get. Never plaintext, never in a list
-- view, never in an export.
ALTER TABLE people ADD COLUMN IF NOT EXISTS ni_number_encrypted TEXT;

CREATE INDEX IF NOT EXISTS idx_people_rtw_expiry ON people(rtw_expires_on)
  WHERE rtw_expires_on IS NOT NULL;

-- NOTE: bank details are deliberately NOT stored here. The accountants hold
-- them for payroll; a second copy is payroll-diversion exposure for no
-- operational benefit. This is a decision (spec §3.1), not an omission.

-- ── staff_employment ────────────────────────────────────────────────────────
-- One row per employee. Presence of a row with employment_status = 'employed'
-- is THE definition of "is this person staff for calendar purposes" — the
-- calendar lists exactly these people.
CREATE TABLE IF NOT EXISTS staff_employment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  employment_status   VARCHAR(20) NOT NULL DEFAULT 'employed'
                        CHECK (employment_status IN ('employed','left')),
  start_date          DATE NOT NULL,
  end_date            DATE,
  job_title           TEXT,
  department          VARCHAR(50),
  -- NULL on both of these means "inherit the global system_settings value".
  -- Present so a future contract can differ without a code change.
  bank_holiday_policy VARCHAR(20)
                        CHECK (bank_holiday_policy IN ('use_allowance','granted')),
  entitlement_weeks   NUMERIC(4,2) CHECK (entitlement_weeks IS NULL OR entitlement_weeks >= 0),
  notes               TEXT,                    -- admin only
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_employment_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_employment_status ON staff_employment(employment_status);

-- ── staff_salary_history ────────────────────────────────────────────────────
-- Append-only. A pay rise is a NEW row, never an edit — the whole point is
-- being able to answer "what were they on, and when did it last change".
-- Admin-gated at the API. Deliberately NOT encrypted: it is not special-
-- category data, it lands in nightly backups regardless, and encrypting it
-- would block the sorting and reporting the directory exists for (spec §3.1).
CREATE TABLE IF NOT EXISTS staff_salary_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  annual_amount  NUMERIC(10,2) NOT NULL CHECK (annual_amount >= 0),
  effective_from DATE NOT NULL,
  reason         TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_salary_person
  ON staff_salary_history(person_id, effective_from DESC);

-- ── staff_reviews ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  review_type     VARCHAR(20) NOT NULL DEFAULT 'annual'
                    CHECK (review_type IN ('quarterly','annual','probation','ad_hoc')),
  scheduled_for   DATE NOT NULL,
  completed_at    TIMESTAMPTZ,
  notes           TEXT,
  outcome         TEXT,
  next_review_due DATE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drives the "review due" reminder: scheduled and not yet done.
CREATE INDEX IF NOT EXISTS idx_staff_reviews_due ON staff_reviews(scheduled_for)
  WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_reviews_person ON staff_reviews(person_id);

-- ── staff_working_patterns ──────────────────────────────────────────────────
-- Effective-dated (spec §0.3). effective_to NULL = the current pattern.
-- cycle_weeks = 2 supports alternating-week patterns; the cycle is anchored on
-- the Monday of the week containing effective_from (see staff-day-status.ts).
CREATE TABLE IF NOT EXISTS staff_working_patterns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  cycle_weeks    INT NOT NULL DEFAULT 1 CHECK (cycle_weeks IN (1,2)),
  notes          TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_working_patterns_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (person_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_staff_patterns_person ON staff_working_patterns(person_id, effective_from DESC);

-- ── staff_working_pattern_days ──────────────────────────────────────────────
-- weekday: 0 = Monday … 6 = Sunday (NOT Postgres/JS Sunday-first — see
-- weekdayIndex() in staff-day-status.ts, which is the only place that converts).
--
-- `minutes` is written by the service from start/end/break and stored, never
-- recomputed at read time: every calendar read depends on it and recomputing
-- per row is how unequal-length days get quietly rounded wrong.
CREATE TABLE IF NOT EXISTS staff_working_pattern_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id    UUID NOT NULL REFERENCES staff_working_patterns(id) ON DELETE CASCADE,
  cycle_week    INT NOT NULL DEFAULT 1 CHECK (cycle_week IN (1,2)),
  weekday       INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  is_working    BOOLEAN NOT NULL DEFAULT true,
  start_time    TIME,
  end_time      TIME,
  break_minutes INT NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  minutes       INT NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  UNIQUE (pattern_id, cycle_week, weekday),
  -- A non-working day carries no time and no minutes; a working day must have both.
  CONSTRAINT staff_pattern_day_shape CHECK (
    (is_working = false AND minutes = 0 AND start_time IS NULL AND end_time IS NULL)
    OR
    (is_working = true AND minutes > 0 AND start_time IS NOT NULL AND end_time IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_pattern_days_pattern ON staff_working_pattern_days(pattern_id);

-- ── staff_pattern_exceptions ────────────────────────────────────────────────
-- A one-off deviation from the pattern for a single date. Two uses:
--   * an ad-hoc change ("working Saturday this week")
--   * a SWAP — legs sharing a swap_group_id, approved or declined as a unit.
--     A self-swap is 2 rows (Tue off + Wed on); a person-to-person swap is 4
--     rows across two people. The model carries both from day one; only the
--     admin-created flow is built in v1 (spec §8.3).
--
-- A swap costs no allowance — it moves which day is contracted, nothing more.
-- Hence no ledger involvement anywhere in this table.
CREATE TABLE IF NOT EXISTS staff_pattern_exceptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  is_working     BOOLEAN NOT NULL,
  start_time     TIME,
  end_time       TIME,
  break_minutes  INT NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  minutes        INT NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  reason         TEXT,
  swap_group_id  UUID,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','declined','cancelled')),
  requested_by   UUID REFERENCES users(id),
  approved_by    UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_exception_shape CHECK (
    (is_working = false AND minutes = 0 AND start_time IS NULL AND end_time IS NULL)
    OR
    (is_working = true AND minutes > 0 AND start_time IS NOT NULL AND end_time IS NOT NULL)
  )
);

-- At most one LIVE exception per person per date. Declined/cancelled rows stay
-- for history and don't block a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_exception_one_live
  ON staff_pattern_exceptions(person_id, exception_date)
  WHERE status IN ('pending','approved');

CREATE INDEX IF NOT EXISTS idx_staff_exceptions_date  ON staff_pattern_exceptions(exception_date);
CREATE INDEX IF NOT EXISTS idx_staff_exceptions_swap  ON staff_pattern_exceptions(swap_group_id)
  WHERE swap_group_id IS NOT NULL;

-- ── backup role grants (skip if the role doesn't exist) ─────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_employment            TO ooosh_backup;
    GRANT SELECT ON staff_salary_history        TO ooosh_backup;
    GRANT SELECT ON staff_reviews               TO ooosh_backup;
    GRANT SELECT ON staff_working_patterns      TO ooosh_backup;
    GRANT SELECT ON staff_working_pattern_days  TO ooosh_backup;
    GRANT SELECT ON staff_pattern_exceptions    TO ooosh_backup;
  END IF;
END $$;
