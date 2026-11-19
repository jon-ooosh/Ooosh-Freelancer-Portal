-- ============================================================================
-- 355: Premises & compliance — phase 1 (docs/PREMISES-COMPLIANCE-SPEC.md)
-- ============================================================================
-- Operations › Premises & compliance: the checks that keep the buildings, the
-- yard and the company legal, insured and serviced, with a record (and its
-- certificate) for every time one is done.
--
--   premises_places    Compass House, Rear Unit, Beach Yard, Whole site, Company
--   premises_headings  Fire, Gas & electrical … (groups on the register)
--   premises_checks    one row per check; WHEN it is next due is next_due,
--                      worked out by services/task-recurrence.ts (never here)
--   premises_records   one row per time a check was done
--   premises_files     certificates / reports / photos on a record, under the
--                      R2 prefix premises/ — gated PER FILE by the download
--                      route (routes/files.ts), never under files/
--
-- Nothing is deleted: checks, places and headings are RETIRED, a record or a
-- file is REMOVED (removed_at / archived_at). A check added by mistake with no
-- records is the one hard delete (services/premises.ts deleteCheck).
--
-- The seeded checks have NO owner and NO date: nobody is reminded about
-- anything until jon sets each one up (spec §11).
-- ============================================================================

CREATE TABLE IF NOT EXISTS premises_places (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  retired_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS premises_headings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  retired_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS premises_checks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               TEXT NOT NULL,
  -- visit: a contractor comes · test: we do it ourselves · reading: a meter
  -- (phase 2) · renewal: a date and a document (insurance, lease, licences)
  kind                VARCHAR(10) NOT NULL CHECK (kind IN ('visit', 'test', 'reading', 'renewal')),
  heading_id          UUID NOT NULL REFERENCES premises_headings(id),
  place_id            UUID NOT NULL REFERENCES premises_places(id),
  -- Who can see it AT ALL (spec §1.5): every staff login, managers, admins.
  visibility          VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'managers', 'admins')),
  owner_person_id     UUID REFERENCES people(id),
  contractor_org_id   UUID REFERENCES organisations(id),
  -- 'landlord': the landlord does it, we keep the copy.
  responsibility      VARCHAR(10) NOT NULL DEFAULT 'ours' CHECK (responsibility IN ('ours', 'landlord')),
  -- How it comes round. NULL mode + rule = a one-off date. The rule is a
  -- task-recurrence.ts RecurrenceRule; the anchor is where a 'schedule' rule
  -- counts from ("every year on 1 Jan" anchors on a 1 Jan).
  repeat_mode         VARCHAR(12) CHECK (repeat_mode IN ('schedule', 'after_done')),
  repeat_rule         JSONB,
  repeat_anchor       DATE,
  next_due            DATE,
  -- computed: from the rule · certificate: typed when it was done (wins)
  -- · typed: set by hand on the check
  next_due_source     VARCHAR(12) CHECK (next_due_source IN ('computed', 'certificate', 'typed')),
  remind_days_before  INT NOT NULL DEFAULT 30 CHECK (remind_days_before BETWEEN 0 AND 365),
  -- The next_due the owner's To Do was last made for — so ticking the To Do
  -- without recording doesn't make another one every morning.
  reminded_for_due    DATE,
  location_note       TEXT,
  why_note            TEXT,
  notes               TEXT,
  retired_at          TIMESTAMPTZ,
  retired_reason      TEXT,
  retired_by          UUID REFERENCES users(id),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT premises_checks_repeat_pair CHECK ((repeat_mode IS NULL) = (repeat_rule IS NULL)),
  CONSTRAINT premises_checks_schedule_anchor CHECK (repeat_mode IS DISTINCT FROM 'schedule' OR repeat_anchor IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_premises_checks_due ON premises_checks(next_due) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS premises_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id            UUID NOT NULL REFERENCES premises_checks(id),
  done_on             DATE NOT NULL,
  done_by_org_id      UUID REFERENCES organisations(id),
  outcome             VARCHAR(12) CHECK (outcome IN ('pass', 'advisories', 'fail')),
  reading_value       NUMERIC(14, 3),
  meter_replaced      BOOLEAN NOT NULL DEFAULT false,
  notes               TEXT,
  -- The next due date this record set on the check (history; may be NULL).
  next_due_set        DATE,
  next_due_source     VARCHAR(12) CHECK (next_due_source IN ('computed', 'certificate')),
  recorded_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at          TIMESTAMPTZ,
  removed_by          UUID REFERENCES users(id),
  removed_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_premises_records_check ON premises_records(check_id, done_on DESC);

CREATE TABLE IF NOT EXISTS premises_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id     UUID NOT NULL REFERENCES premises_records(id),
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INT,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ,
  archived_by   UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_premises_files_record ON premises_files(record_id);

-- ── Seed: places and headings (jon, 19 Nov 2026) ────────────────────────────

INSERT INTO premises_places (name, sort_order)
SELECT v.name, v.sort_order
  FROM (VALUES ('Compass House', 1), ('Rear Unit', 2), ('Beach Yard', 3), ('Whole site', 4), ('Company', 5))
       AS v(name, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM premises_places);

INSERT INTO premises_headings (name, sort_order)
SELECT v.name, v.sort_order
  FROM (VALUES ('Fire', 1), ('Gas & electrical', 2), ('Air & water', 3), ('Building & equipment', 4),
               ('Insurance', 5), ('Lease & legal', 6), ('Licences & registrations', 7))
       AS v(name, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM premises_headings);

-- ── Seed: the starting list (spec §11, as amended by jon 19 Nov 2026) ───────
-- Every repeat is 'after_done' ("N after the last one") until jon sets a fixed
-- date; one-offs have no rule. Building checks start on "Whole site" — the
-- place is changed as each is set up. No owner, no date: no reminders yet.

INSERT INTO premises_checks (title, kind, heading_id, place_id, visibility, repeat_mode, repeat_rule, remind_days_before)
SELECT s.title, s.kind, h.id, p.id, s.visibility,
       CASE WHEN s.rule IS NULL THEN NULL ELSE 'after_done' END,
       s.rule::jsonb, s.remind
  FROM (VALUES
    ('Fire risk assessment review',               'visit',   'Fire',                     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Fire alarm service',                        'visit',   'Fire',                     'Whole site', 'all',    '{"freq":"month","interval":6}',  30),
    ('Fire alarm test',                           'test',    'Fire',                     'Whole site', 'all',    '{"freq":"week","interval":1}',   0),
    ('Emergency lighting flick test',             'test',    'Fire',                     'Whole site', 'all',    '{"freq":"month","interval":1}',  0),
    ('Emergency lighting full-duration test',     'visit',   'Fire',                     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Fire extinguisher service',                 'visit',   'Fire',                     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Gas safety inspection / boiler service',    'visit',   'Gas & electrical',         'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('EICR (fixed wiring)',                       'visit',   'Gas & electrical',         'Whole site', 'all',    '{"freq":"year","interval":5}',   60),
    ('PAT testing (office and studio kit)',       'visit',   'Gas & electrical',         'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Air con service and F-gas leak check',      'visit',   'Air & water',              'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Air con energy inspection (TM44)',          'visit',   'Air & water',              'Whole site', 'all',    '{"freq":"year","interval":5}',   60),
    ('Asbestos register review',                  'renewal', 'Building & equipment',     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Pallet racking inspection',                 'visit',   'Building & equipment',     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Roller shutter / powered doors service',    'visit',   'Building & equipment',     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('Intruder alarm and CCTV service',           'visit',   'Building & equipment',     'Whole site', 'all',    '{"freq":"year","interval":1}',   30),
    ('First aid kits check',                      'test',    'Building & equipment',     'Whole site', 'all',    '{"freq":"month","interval":1}',  0),
    ('Buildings and contents insurance',          'renewal', 'Insurance',                'Company',    'admins', '{"freq":"year","interval":1}',   30),
    -- Everyone: the law says employees must be able to see the certificate.
    ('Employers'' liability insurance',           'renewal', 'Insurance',                'Company',    'all',    '{"freq":"year","interval":1}',   30),
    ('Public liability insurance',                'renewal', 'Insurance',                'Company',    'admins', '{"freq":"year","interval":1}',   30),
    ('Lease breaks and rent reviews',             'renewal', 'Lease & legal',            'Whole site', 'admins', NULL,                             90),
    ('EPC (energy performance certificate)',      'renewal', 'Lease & legal',            'Whole site', 'all',    '{"freq":"year","interval":10}',  90),
    ('ICO data protection fee',                   'renewal', 'Licences & registrations', 'Company',    'all',    '{"freq":"year","interval":1}',   30),
    ('PRS & PPL licence',                         'renewal', 'Licences & registrations', 'Company',    'all',    '{"freq":"year","interval":1}',   30),
    ('Waste transfer notes',                      'renewal', 'Licences & registrations', 'Whole site', 'all',    '{"freq":"year","interval":1}',   30)
  ) AS s(title, kind, heading, place, visibility, rule, remind)
  JOIN premises_headings h ON h.name = s.heading
  JOIN premises_places p ON p.name = s.place
 WHERE NOT EXISTS (SELECT 1 FROM premises_checks);
