-- ============================================================================
-- 135: ATA Carnet management
--
-- Replaces the Monday board + Jotform carnet request flow. Two modes on one
-- record: 'we_supply' (HH-detected via sale item 575, full lifecycle) and
-- 'client_arranges' (manual lightweight "thing to do"). Per-job scope.
--
-- GMRs (Goods Movement References) are an unbounded child list — one per EU
-- border crossing — tracked requested -> made -> sent, with the number + QR
-- image stored for forwarding to the client.
--
-- The `carnet` job_requirement type is already seeded (migration 021); it
-- stays the thin prep-checklist pip that deep-links into this module.
--
-- See docs/CARNET-SPEC.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_carnets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  mode                     VARCHAR(20) NOT NULL DEFAULT 'we_supply'
                             CHECK (mode IN ('we_supply', 'client_arranges')),
  status                   VARCHAR(30) NOT NULL DEFAULT 'detected',
  format                   VARCHAR(10) NOT NULL DEFAULT 'paper'
                             CHECK (format IN ('paper', 'digital')),

  -- Custody snapshot (where the physical/digital document is right now).
  -- Auto-set on status transitions, manual override allowed.
  custody_location         VARCHAR(10)
                             CHECK (custody_location IN ('ooosh', 'client', 'issuer')),

  -- ── Client form submission data (we_supply) ──
  carnet_length_months     INTEGER,             -- 2 | 6 | 12
  carnet_start_date        DATE,
  carnet_expiry_date       DATE,                -- derived: start + length
  liability_until          DATE,                -- derived: expiry + 18 months (per authority)

  eu_countries             TEXT[] NOT NULL DEFAULT '{}',
  non_eu_countries         TEXT[] NOT NULL DEFAULT '{}',

  lead_name                TEXT,
  lead_email               TEXT,
  lead_role                TEXT,                -- "role in touring party" — shown as the
                                                -- client's role/designation on the authority
  additional_names         JSONB NOT NULL DEFAULT '[]',  -- [{ first, last }] — unlimited

  -- ── Workflow refs / timestamps ──
  application_ref          TEXT,
  applied_at               TIMESTAMPTZ,
  received_at              TIMESTAMPTZ,
  issued_to_client_at      TIMESTAMPTZ,
  returned_at              TIMESTAMPTZ,
  discharged_at            TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,

  -- ── Client-facing request form (we_supply) ──
  form_token               TEXT,
  form_sent_at             TIMESTAMPTZ,
  form_reminder_sent_at    TIMESTAMPTZ,
  form_submitted_at        TIMESTAMPTZ,         -- = authority signed (combined form)
  signed_authority_url     TEXT,                -- R2 key, generated PDF

  -- ── client_arranges minimal mode ──
  spreadsheet_requested_at TIMESTAMPTZ,
  spreadsheet_sent_at      TIMESTAMPTZ,
  chase_date               DATE,

  files                    JSONB NOT NULL DEFAULT '[]',
  notes                    TEXT,

  keep_after_close         BOOLEAN NOT NULL DEFAULT FALSE,  -- lost/cancelled cleanup contract
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live carnet per job (v1). Cancelled rows preserved for audit.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_job_carnet_live
  ON job_carnets (job_id)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_job_carnets_job ON job_carnets (job_id);
CREATE INDEX IF NOT EXISTS idx_job_carnets_status ON job_carnets (status);
CREATE INDEX IF NOT EXISTS idx_job_carnets_token ON job_carnets (form_token) WHERE form_token IS NOT NULL;


CREATE TABLE IF NOT EXISTS carnet_gmrs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carnet_id         UUID NOT NULL REFERENCES job_carnets(id) ON DELETE CASCADE,

  crossing_date     DATE,
  crossing_location TEXT,                       -- free text: Dover/Calais/Folkestone/Eurotunnel/other
  direction         VARCHAR(10) CHECK (direction IN ('into_eu', 'out_of_eu')),

  status            VARCHAR(10) NOT NULL DEFAULT 'needed'
                      CHECK (status IN ('needed', 'made', 'sent')),
  gmr_reference     TEXT,                        -- the GMR number
  qr_image_url      TEXT,                        -- R2 key for the uploaded QR image
  sent_to_client_at TIMESTAMPTZ,

  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carnet_gmrs_carnet ON carnet_gmrs (carnet_id);
