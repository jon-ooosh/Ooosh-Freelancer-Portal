-- ============================================================================
-- 238: Pension history, marital status — the last of the basic employer record
-- ============================================================================
-- jon, Sep 2026: "contact details, emergency contact, pension, DOB, marital
-- status… all basic stuff any employer should have."
--
-- MOST OF THAT LIST ALREADY EXISTED and needed surfacing, not adding — the
-- same finding as Phase 2. Already on `people` and NOT re-added here:
--
--   phone · mobile · international_phone · home_address · date_of_birth
--   emergency_contact_name/phone/relationship        (mig 001)
--   emergency_contact_2_name/phone/relationship      (mig 206)
--
-- They have been on the People record since migration 001 and were simply
-- never editable from the staff area. Only two things were genuinely missing.
-- ============================================================================

-- ── Marital status ──────────────────────────────────────────────────────────
-- Free text rather than an enum on purpose: "civil partnership", "separated"
-- and "prefer not to say" are all real answers, the list differs by who you
-- ask, and a CHECK constraint here buys nothing — nothing computes from it.
ALTER TABLE people ADD COLUMN IF NOT EXISTS marital_status VARCHAR(40);

COMMENT ON COLUMN people.marital_status IS
  'Free text. Private staff data — listed in services/people-private-fields.ts so it never leaves a general people response.';

-- ── Pension ─────────────────────────────────────────────────────────────────
-- Append-only, exactly like staff_salary_history (mig 206): a contribution
-- change is a NEW ROW, never an edit, because the whole point is being able to
-- answer "what were they on, and from when". Auto-enrolment makes that a
-- question with legal weight — the percentages and the dates they applied from
-- are what a pension provider or an audit asks for.
--
-- Deliberately NOT a pair of columns on staff_employment: that would keep the
-- current figure and lose every previous one, which is the half that matters.
CREATE TABLE IF NOT EXISTS staff_pension_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,

  -- Opted out is a RECORDED state, not an absent row: "we have no pension row
  -- for Sam" and "Sam opted out on 3 March" are different facts, and only the
  -- second one is evidence.
  is_member         BOOLEAN NOT NULL DEFAULT true,
  scheme_name       TEXT,
  employee_percent  NUMERIC(5,2) CHECK (employee_percent IS NULL OR (employee_percent >= 0 AND employee_percent <= 100)),
  employer_percent  NUMERIC(5,2) CHECK (employer_percent IS NULL OR (employer_percent >= 0 AND employer_percent <= 100)),

  effective_from    DATE NOT NULL,
  reason            TEXT,
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What are they on now" = the latest effective_from; the index serves both
-- that and the full history read.
CREATE INDEX IF NOT EXISTS idx_staff_pension_person
  ON staff_pension_history(person_id, effective_from DESC);

COMMENT ON TABLE staff_pension_history IS
  'Append-only pension record. A change is a new row, never an edit — see staff_salary_history, which this mirrors. Admin-only.';
