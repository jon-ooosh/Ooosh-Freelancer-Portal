-- ============================================================================
-- 214: Staff Calendar & Time — Phase D (absence, RTW, holiday reclaim)
-- ============================================================================
-- See docs/STAFF-CALENDAR-SPEC.md §3.7, §7.
--
-- SHAPE MIRRORS LEAVE, DELIBERATELY. A header row carries the spell; a row per
-- day carries what the calendar and the pricing read. The reasons are the same
-- ones written up in migration 209:
--
--   1. Each day SNAPSHOTS the minutes it cost, from the pattern in force when
--      the row was generated (spec §0.3).
--   2. NON-WORKING DAYS GET NO ROW. A sickness spanning a weekend does not
--      invent two days of sickness. The SPELL (start_date … end_date on the
--      header) keeps the true calendar span for reporting and for the SSP flag
--      the accountants want; the DAYS carry the cost. Two questions, two
--      sources, neither re-derived from the other.
--   3. It is what staff-day-status.ts overlays onto the calendar.
--
-- SPECIAL-CATEGORY DATA. Everything below `reason_category` is UK GDPR
-- special-category (spec §0.5) and is admin-only at the API. The masking lives
-- in services/staff-day-status.ts, not in the browser — see the rule file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_absences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  absence_type  VARCHAR(30) NOT NULL CHECK (absence_type IN
                  ('sickness','maternity','paternity','shared_parental','adoption',
                   'bereavement','compassionate','goodwill','jury_service',
                   'medical_appointment','other')),

  start_date    DATE NOT NULL,

  -- NULL while the absence is still running. An open sickness must keep
  -- showing on the calendar every day it continues, which is what the
  -- catch-up in services/staff-absence.ts materialises day rows for.
  end_date      DATE,
  is_open       BOOLEAN NOT NULL DEFAULT true,

  -- Soft-cancel, per CLAUDE.md. An absence entered against the wrong person or
  -- the wrong dates has to be retractable, and deleting it would take its day
  -- rows — and any ledger line that referenced it — with it.
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','cancelled')),

  -- FALSE for almost everything: sickness, bereavement and goodwill do not
  -- come out of someone's holiday. It exists so an odd case can be handled
  -- without inventing a new absence type (spec §3.7).
  deducts_allowance BOOLEAN NOT NULL DEFAULT false,

  -- Computed on close, from the day rows. Stored because the header is what
  -- the reports read and recomputing a closed spell from a pattern that may
  -- since have changed would give a different answer every year.
  total_minutes INT,
  working_days  NUMERIC(5,2),

  -- ── ADMIN ONLY from here down (spec §0.5) ────────────────────────────────
  reason_category   VARCHAR(50),
  notes             TEXT,
  self_certified    BOOLEAN NOT NULL DEFAULT false,
  fit_note_received BOOLEAN NOT NULL DEFAULT false,
  fit_note_expiry   DATE,

  -- Flagged for the accountants; we do not compute SSP (spec §16).
  ssp_qualifying    BOOLEAN,

  -- Return to work (spec §7.3).
  rtw_required      BOOLEAN NOT NULL DEFAULT true,
  rtw_date          DATE,          -- when the conversation happened…
  rtw_completed_at  TIMESTAMPTZ,   -- …as against when it was recorded here
  rtw_by            UUID REFERENCES users(id),

  -- THREE states, not two. §7.3 asks "yes / yes with adjustments / no" and a
  -- boolean cannot hold the middle one, which is the answer that actually
  -- carries an obligation.
  rtw_fit_to_return VARCHAR(20)
                      CHECK (rtw_fit_to_return IS NULL OR rtw_fit_to_return IN
                        ('yes','yes_with_adjustments','no')),
  rtw_adjustments   TEXT,
  rtw_notes         TEXT,

  -- The 7-day chase fires ONCE (§7.3). Without somewhere to record that it
  -- fired, it either never runs or runs every morning forever.
  rtw_chased_at     TIMESTAMPTZ,

  cancelled_by        UUID REFERENCES users(id),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,

  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_absence_dates CHECK (end_date IS NULL OR end_date >= start_date),

  -- is_open is derivable from end_date, and the spec asks for both. Tie them
  -- together so they cannot drift into disagreeing about whether the absence
  -- has finished.
  CONSTRAINT staff_absence_open_matches_end CHECK (
    (is_open = true AND end_date IS NULL) OR (is_open = false AND end_date IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_absence_person ON staff_absences(person_id, start_date DESC);
CREATE INDEX IF NOT EXISTS idx_staff_absence_open   ON staff_absences(person_id)
  WHERE is_open AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_staff_absence_range  ON staff_absences(start_date, end_date)
  WHERE status = 'active';

-- Outstanding return-to-work records — the chase reads exactly this.
CREATE INDEX IF NOT EXISTS idx_staff_absence_rtw_due ON staff_absences(end_date)
  WHERE status = 'active' AND rtw_required AND rtw_completed_at IS NULL AND is_open = false;

CREATE TABLE IF NOT EXISTS staff_absence_days (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  absence_id   UUID NOT NULL REFERENCES staff_absences(id) ON DELETE CASCADE,

  -- Denormalised from the parent, because a unique index cannot reach through
  -- a join — the same reason staff_leave_request_days carries it.
  person_id    UUID NOT NULL,
  absence_date DATE NOT NULL,

  -- Snapshot, NOT recomputed at read time. Zero is legal: a non-deducting
  -- appointment marker still occupies the calendar.
  minutes      INT NOT NULL CHECK (minutes >= 0),

  portion      VARCHAR(10) NOT NULL DEFAULT 'full'
                 CHECK (portion IN ('full','am','pm','hours')),
  start_time   TIME,
  end_time     TIME,

  -- Kept in step with the parent's status by a trigger, so a cancelled
  -- absence stops occupying the calendar without anything being deleted.
  is_active    BOOLEAN NOT NULL DEFAULT true,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (absence_id, absence_date),

  -- Same rule as leave (migration 212): a timed period carries its times, a
  -- whole or half day must not.
  CONSTRAINT staff_absence_day_times CHECK (
    (portion = 'hours' AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    OR
    (portion <> 'hours' AND start_time IS NULL AND end_time IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_staff_absence_days_person ON staff_absence_days(person_id, absence_date)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_staff_absence_days_abs    ON staff_absence_days(absence_id);

-- ── One whole-or-half-day absence per person per day ────────────────────────
--
-- Two overlapping open sicknesses would double-count every day of the spell,
-- and if either deducted allowance it would debit the same day twice — data
-- corruption rather than inconvenience, so it is one of the things that hard
-- refuses (see .claude/rules/staff-calendar.md).
--
-- TIMED MARKERS ARE EXCLUDED from this index on purpose. "In late and away
-- early" is two genuinely separate periods on one day, and the trigger below
-- is what keeps those from overlapping each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_absence_one_per_day
  ON staff_absence_days(person_id, absence_date)
  WHERE is_active AND portion <> 'hours';

-- ── Timed markers must not overlap ──────────────────────────────────────────
--
-- A trigger rather than an EXCLUDE constraint because the latter needs
-- btree_gist, and installing an extension needs a superuser on the box —
-- migration 175 already carries the scar from that. With seven staff the
-- race a trigger leaves open is not a real one.
CREATE OR REPLACE FUNCTION staff_absence_day_no_clash()
RETURNS trigger AS $$
DECLARE
  clash_start TIME;
  clash_end   TIME;
BEGIN
  IF NOT NEW.is_active THEN RETURN NEW; END IF;

  IF NEW.portion = 'hours' THEN
    -- …against a whole day off. They are already out; a marker inside it is
    -- noise, and it would render as "out 14:00–15:00" on a day they are away.
    IF EXISTS (
      SELECT 1 FROM staff_absence_days d
       WHERE d.person_id = NEW.person_id
         AND d.absence_date = NEW.absence_date
         AND d.is_active
         AND d.portion = 'full'
         AND d.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'That person is already absent for the whole of %', NEW.absence_date
        USING HINT = 'Cancel the whole-day absence first, or widen it instead of adding a marker.';
    END IF;

    -- …and against another marker on the same day.
    SELECT d.start_time, d.end_time INTO clash_start, clash_end
      FROM staff_absence_days d
     WHERE d.person_id = NEW.person_id
       AND d.absence_date = NEW.absence_date
       AND d.is_active
       AND d.portion = 'hours'
       AND d.id <> NEW.id
       AND d.start_time < NEW.end_time
       AND d.end_time   > NEW.start_time
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'That overlaps an existing % – % marker on %',
        to_char(clash_start, 'HH24:MI'), to_char(clash_end, 'HH24:MI'), NEW.absence_date
        USING HINT = 'Two periods in one day are fine as long as they do not overlap.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_absence_day_no_clash ON staff_absence_days;
CREATE TRIGGER trg_staff_absence_day_no_clash
  BEFORE INSERT OR UPDATE ON staff_absence_days
  FOR EACH ROW EXECUTE FUNCTION staff_absence_day_no_clash();

-- ── Cancelling the parent retires its days ──────────────────────────────────
-- Same pattern as staff_leave_days_sync_live (migration 209): a trigger rather
-- than service code, because every path that changes a status would otherwise
-- have to remember, and one that forgets fails silently.
CREATE OR REPLACE FUNCTION staff_absence_days_sync_active()
RETURNS trigger AS $$
BEGIN
  UPDATE staff_absence_days
     SET is_active = (NEW.status = 'active'),
         person_id = NEW.person_id
   WHERE absence_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_absence_days_sync_active ON staff_absences;
CREATE TRIGGER trg_staff_absence_days_sync_active
  AFTER UPDATE OF status ON staff_absences
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION staff_absence_days_sync_active();

-- ── The reclaim link finally gets its foreign key ───────────────────────────
-- Migration 209 landed staff_leave_request_days.reclaimed_absence_id as a bare
-- UUID with a comment saying the FK would follow once the absence table
-- existed (spec §7.4). It exists now.
--
-- SET NULL rather than CASCADE: if an absence row were ever removed, the
-- holiday day itself is still a real booked day and must not go with it.
ALTER TABLE staff_leave_request_days
  DROP CONSTRAINT IF EXISTS staff_leave_days_reclaimed_absence_fk;
ALTER TABLE staff_leave_request_days
  ADD CONSTRAINT staff_leave_days_reclaimed_absence_fk
  FOREIGN KEY (reclaimed_absence_id) REFERENCES staff_absences(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_staff_leave_days_reclaimed
  ON staff_leave_request_days(reclaimed_absence_id)
  WHERE reclaimed_absence_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON staff_absences     TO ooosh_backup;
    GRANT SELECT ON staff_absence_days TO ooosh_backup;
  END IF;
END $$;
