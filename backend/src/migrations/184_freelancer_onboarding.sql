-- 179_freelancer_onboarding.sql
-- Freelancer Onboarding module — Phase A (data model).
-- See docs/FREELANCER-ONBOARDING-SPEC.md.
--
-- The full module schema lands here in one migration (application/token table +
-- all new person columns) so later phases (public apply form, review, reminders)
-- need no further migration. Columns are harmless while unused.

-- ── freelancer_applications ────────────────────────────────────────────────
-- One row per application. A re-invite (annual re-consent) gets a NEW row,
-- keeping full history. person_id is created/linked at invite time.
CREATE TABLE IF NOT EXISTS freelancer_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  form_token          TEXT UNIQUE NOT NULL,          -- base64url randomBytes(24) — the gated link
  status              TEXT NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited','applied','more_info','approved','declined')),
  invited_by          UUID REFERENCES users(id),
  invited_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at        TIMESTAMPTZ,
  reviewed_by         UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  decision_notes      TEXT,                          -- decline reason / more-info request
  submission          JSONB,                         -- raw submitted answers (audit / re-render)
  insurance_answers   JSONB,                         -- 4 insurance questionnaire Q&A + detail
  "references"        JSONB,                         -- [{name, company, email, phone, role, consent}]
  signature_r2_key    TEXT,                          -- signed T&Cs signature image
  tcs_version         TEXT,                          -- which T&Cs/GDPR text was agreed
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_freelancer_applications_person ON freelancer_applications(person_id);
CREATE INDEX IF NOT EXISTS idx_freelancer_applications_status ON freelancer_applications(status);
-- Fast token lookup for the public form (partial: only live tokens matter).
CREATE INDEX IF NOT EXISTS idx_freelancer_applications_token ON freelancer_applications(form_token)
  WHERE status IN ('invited','more_info');

-- ── people: freelancer lifecycle + document dates ──────────────────────────
-- Denormalised status mirror for fast picker/list queries. Canonical status
-- lives on the latest freelancer_applications row; this is kept in sync.
ALTER TABLE people ADD COLUMN IF NOT EXISTS freelancer_status TEXT
  CHECK (freelancer_status IN ('invited','applied','more_info','approved','declined'));

-- Onboarding checklist state that has no existing column of its own
-- (portal invite sent, resources shared, etc.). has_tshirt / is_insured_on_vehicles
-- already exist and are reused directly.
ALTER TABLE people ADD COLUMN IF NOT EXISTS onboarding JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Soft "off the books" audit (untick is_freelancer). Do Not Hire covers the hard case.
ALTER TABLE people ADD COLUMN IF NOT EXISTS freelancer_removed_at TIMESTAMPTZ;
ALTER TABLE people ADD COLUMN IF NOT EXISTS freelancer_removed_reason TEXT;

-- Preferred name ("I prefer to be known as…") + expected day-rate note.
ALTER TABLE people ADD COLUMN IF NOT EXISTS preferred_name TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS day_rate_note TEXT;

-- Queryable document dates — drive the expiry reminder scanner (Phase D).
-- Actual document FILES continue to live in people.files JSONB.
ALTER TABLE people ADD COLUMN IF NOT EXISTS licence_number TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS licence_issued_by TEXT;
ALTER TABLE people ADD COLUMN IF NOT EXISTS licence_expiry DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS licence_passed_date DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS dvla_check_date DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS passport_expiry DATE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pli_expiry DATE;

-- Partial indexes for the reminder scanner (only freelancers, only set dates).
CREATE INDEX IF NOT EXISTS idx_people_licence_expiry ON people(licence_expiry)
  WHERE is_freelancer = true AND licence_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_passport_expiry ON people(passport_expiry)
  WHERE is_freelancer = true AND passport_expiry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_freelancer_status ON people(freelancer_status)
  WHERE is_freelancer = true;

-- Backfill the denormalised status for existing freelancers so pickers read
-- something sensible from day one: approved ones show 'approved'.
UPDATE people
   SET freelancer_status = 'approved'
 WHERE is_freelancer = true
   AND is_approved = true
   AND freelancer_status IS NULL;
