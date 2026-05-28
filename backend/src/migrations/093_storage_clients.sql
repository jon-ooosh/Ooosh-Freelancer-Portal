-- ============================================================================
-- 093: Client Storage — foundation
--
-- Standalone OP-native module replacing the Monday.com "Storage Clients" board.
-- Ooosh rents ~20 storage rooms to clients long-term. Deliberately NOT in
-- HireHop (no per-month book-in/out). See docs/STORAGE-CLIENTS-SPEC.md.
--
-- Tables:
--   storage_rooms          — the ~20 physical rooms (size, access, photos)
--   storage_tenancies      — who's in which room, rate, billing/review cadence
--   storage_rate_history   — full audit of rate changes
--   storage_invoice_log    — record of each manual invoice marked sent
--   storage_access_list    — people allowed into a unit
--   storage_access_events  — "collect X / courier Y" requests + done tracking
--   storage_waiting_list   — prospects waiting for a space
--   storage_tcs_versions   — versioned T&Cs documents
--   storage_tcs_agreements — per-tenancy acceptance (signature + timestamp)
-- ============================================================================

-- ── Rooms ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(120) NOT NULL,
  size_category   VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (size_category IN ('small', 'medium', 'large', 'xl')),
  dimensions      VARCHAR(120),
  area_sqft       NUMERIC(8,1),
  access_type     VARCHAR(20) NOT NULL DEFAULT 'door_code'
    CHECK (access_type IN ('door_code', 'we_hold_key', 'client_key')),
  -- NOTE: access_code is plaintext for now. It will move to the PII encryption
  -- layer (services/encryption.ts, AES-256-GCM) once that lands — see
  -- docs/STORAGE-CLIENTS-SPEC.md §9. Until then it's STAFF_ROLES-gated + audited.
  access_code     TEXT,
  key_location    VARCHAR(200),
  description      TEXT,
  photos           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Manual status override; 'occupied' is otherwise derived from active tenancy.
  status           VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'occupied', 'reserved', 'out_of_use')),
  notes            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tenancies ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_tenancies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id                  UUID NOT NULL REFERENCES storage_rooms(id),
  organisation_id          UUID REFERENCES organisations(id),
  lead_contact_person_id   UUID REFERENCES people(id),
  status                   VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('reserved', 'active', 'notice', 'ended')),
  move_in_date             DATE,
  move_out_date            DATE,
  weekly_rate              NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Billing
  billing_mode             VARCHAR(20) NOT NULL DEFAULT 'manual'
    CHECK (billing_mode IN ('recurring', 'manual')),
  billing_cadence          VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (billing_cadence IN ('monthly', 'quarterly', 'annual', 'custom')),
  next_bill_date           DATE,                         -- when the next invoice is due to be sent (manual mode)
  bill_reminder_person_id  UUID REFERENCES users(id),    -- who gets nudged
  bill_reminder_lead_days  INT NOT NULL DEFAULT 7,       -- "due soon" lead time
  bill_overdue_grace_days  INT NOT NULL DEFAULT 5,       -- nudge if still unticked this long after due
  billing_reminder_sent_for DATE,                        -- dedup: due-soon already sent for this due date
  billing_overdue_sent_for  DATE,                        -- dedup: overdue already sent for this due date

  -- Rate review
  rate_review_cadence       VARCHAR(20) NOT NULL DEFAULT 'annual'
    CHECK (rate_review_cadence IN ('annual', 'biennial', 'custom')),
  next_rate_review_date     DATE,
  rate_review_sent_for      DATE,                         -- dedup
  last_rate_change_date     DATE,                         -- denormalised for quick display
  previous_weekly_rate      NUMERIC(10,2),                -- denormalised "before" amount

  -- T&Cs
  tcs_agreement_id          UUID,                         -- FK added after agreements table exists
  tcs_token                 VARCHAR(80),                  -- public accept-link token (cleared on accept)
  tcs_sent_at               TIMESTAMPTZ,

  notes                     TEXT,
  created_by                UUID REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_tenancies_room ON storage_tenancies(room_id);
CREATE INDEX IF NOT EXISTS idx_storage_tenancies_org ON storage_tenancies(organisation_id);
CREATE INDEX IF NOT EXISTS idx_storage_tenancies_status ON storage_tenancies(status);
-- At most one active/notice/reserved tenancy per room (ended ones don't count)
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_tenancies_one_live_per_room
  ON storage_tenancies(room_id) WHERE status IN ('active', 'notice', 'reserved');

-- ── Rate history ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_rate_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id      UUID NOT NULL REFERENCES storage_tenancies(id) ON DELETE CASCADE,
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  old_rate        NUMERIC(10,2),
  new_rate        NUMERIC(10,2) NOT NULL,
  changed_by      UUID REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_rate_history_tenancy ON storage_rate_history(tenancy_id);

-- ── Invoice log (manual billing audit) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_invoice_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id      UUID NOT NULL REFERENCES storage_tenancies(id) ON DELETE CASCADE,
  due_date        DATE NOT NULL,           -- the cycle due date this invoice covered
  amount          NUMERIC(10,2),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by         UUID REFERENCES users(id),
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_invoice_log_tenancy ON storage_invoice_log(tenancy_id);

-- ── Access list ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_access_list (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id      UUID NOT NULL REFERENCES storage_tenancies(id) ON DELETE CASCADE,
  person_id       UUID REFERENCES people(id),
  name            VARCHAR(200),            -- free-text fallback when not an address-book person
  phone           VARCHAR(40),
  relationship    VARCHAR(120),
  notes           TEXT,
  added_by        UUID REFERENCES users(id),
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_access_list_tenancy ON storage_access_list(tenancy_id);

-- ── Access events / requests ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_access_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id          UUID REFERENCES storage_tenancies(id) ON DELETE SET NULL,
  room_id             UUID REFERENCES storage_rooms(id),
  type                VARCHAR(20) NOT NULL DEFAULT 'visit'
    CHECK (type IN ('visit', 'retrieve', 'courier_out', 'deposit')),
  description         TEXT,
  requested_by        UUID REFERENCES users(id),
  attendee_person_id  UUID REFERENCES people(id),
  attendee_name       VARCHAR(200),
  method              VARCHAR(20) NOT NULL DEFAULT 'in_person'
    CHECK (method IN ('in_person', 'courier')),
  requested_date      DATE,
  status              VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'scheduled', 'done', 'cancelled')),
  actioned_by         UUID REFERENCES users(id),
  actioned_at         TIMESTAMPTZ,
  notified_at         TIMESTAMPTZ,         -- dedup for the daily scanner
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_access_events_status ON storage_access_events(status);
CREATE INDEX IF NOT EXISTS idx_storage_access_events_tenancy ON storage_access_events(tenancy_id);

-- ── Waiting list ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_waiting_list (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID REFERENCES organisations(id),
  person_id       UUID REFERENCES people(id),
  contact_name    VARCHAR(200),
  contact_email   VARCHAR(200),
  contact_phone   VARCHAR(40),
  preferred_size  VARCHAR(20)
    CHECK (preferred_size IS NULL OR preferred_size IN ('small', 'medium', 'large', 'xl', 'any')),
  date_requested  DATE NOT NULL DEFAULT CURRENT_DATE,
  date_last_offered DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'offered', 'converted', 'declined', 'withdrawn')),
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_waiting_list_status ON storage_waiting_list(status);

-- ── T&Cs versions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_tcs_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version         VARCHAR(40) NOT NULL,
  body            TEXT NOT NULL,           -- HTML body shown on the accept page
  effective_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Only one current version at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_tcs_versions_current
  ON storage_tcs_versions(is_current) WHERE is_current = TRUE;

-- ── T&Cs agreements ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_tcs_agreements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id      UUID NOT NULL REFERENCES storage_tenancies(id) ON DELETE CASCADE,
  version_id      UUID REFERENCES storage_tcs_versions(id),
  accepted_by_name VARCHAR(200) NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signature_r2_key TEXT,                   -- R2 key of the signature image
  pdf_r2_key      TEXT,                    -- R2 key of the signed snapshot PDF
  ip_address      VARCHAR(60),
  user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_storage_tcs_agreements_tenancy ON storage_tcs_agreements(tenancy_id);

-- Now wire the tenancy → agreement FK
ALTER TABLE storage_tenancies
  ADD CONSTRAINT fk_storage_tenancies_tcs_agreement
  FOREIGN KEY (tcs_agreement_id) REFERENCES storage_tcs_agreements(id);
