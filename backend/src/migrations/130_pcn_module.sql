-- ============================================================================
-- 130: PCN module — Penalty Charge Notice management (Monday → OP)
--
-- Re-homes the standalone PCN-Management-System Netlify app inside OP.
-- Standalone module under Vehicles with FK anchors into the existing
-- entities (fleet_vehicles / drivers / vehicle_hire_assignments / jobs /
-- organisations). See docs/PCN-MODULE-SPEC.md.
--
-- PR 1 (foundation): tables + event timeline + settings seed.
-- Pay-direct receipt loop, AI extraction, HH charge, email templates,
-- chasers and dashboard buckets land in later PRs.
--
-- Tables:
--   pcns         — the tracker record (replaces the Monday PCN Tracker board)
--   pcn_events   — typed audit timeline (mirrors job_issue_events)
-- ============================================================================

-- ── PCN records ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pcns (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  reference               TEXT,
  fine_type               VARCHAR(20) NOT NULL DEFAULT 'other'
    CHECK (fine_type IN ('private_pcn', 'council_pcn', 'police_nip', 'toll', 'other')),

  -- Anchors (all nullable; at least one of vehicle_id / job_id expected in practice)
  vehicle_id              UUID REFERENCES fleet_vehicles(id),
  driver_id               UUID REFERENCES drivers(id),
  assignment_id           UUID REFERENCES vehicle_hire_assignments(id),
  job_id                  UUID REFERENCES jobs(id),
  client_organisation_id  UUID REFERENCES organisations(id),
  hh_job_number           INTEGER,            -- denormalised for comms + display
  vehicle_reg             TEXT,               -- denormalised, as extracted (survives unmatched)

  -- Extracted detail
  offence_at              TIMESTAMPTZ,        -- combined offence date + time
  offence_time_text       TEXT,               -- raw "HH:MM" as extracted (avoids tz drift)
  location                TEXT,
  issuing_authority       TEXT,
  offence_description     TEXT,
  fine_amount             NUMERIC(10,2),
  reduced_amount          NUMERIC(10,2),
  reduced_deadline        DATE,
  final_deadline          DATE,
  extraction_confidence   VARCHAR(10),        -- 'high' | 'medium' | 'low'

  -- Lifecycle
  status                  VARCHAR(30) NOT NULL DEFAULT 'received'
    CHECK (status IN (
      'received',
      'awaiting_driver_id',
      'driver_notified_pay',
      'paid_by_driver',
      'liability_transferred',
      'paid_recharged',
      'internal_ooosh',
      'internal_freelancer',
      'under_query',
      'closed'
    )),
  action_path             VARCHAR(24)
    CHECK (action_path IN (
      'pay_direct', 'transfer_liability', 'pay_recharge',
      'internal_ooosh', 'internal_freelancer', 'query'
    )),

  -- Handling charge (£35+VAT, conditional on pay-direct path — see spec §6)
  handling_charge_applied BOOLEAN NOT NULL DEFAULT FALSE,
  handling_amount         NUMERIC(10,2),
  hh_charge_pushed_at     TIMESTAMPTZ,

  -- Pay-direct / receipt loop (wired in a later PR)
  pay_direct_deadline     TIMESTAMPTZ,
  receipt_url             TEXT,
  receipt_uploaded_at     TIMESTAMPTZ,
  receipt_chase_level     SMALLINT NOT NULL DEFAULT 0,
  receipt_chase_sent_for  TEXT,

  -- Audit
  pcn_document_url        TEXT,
  handled_by              UUID REFERENCES users(id),
  notes                   TEXT,
  is_deleted              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcns_vehicle   ON pcns(vehicle_id)   WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_pcns_driver    ON pcns(driver_id)    WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_pcns_job       ON pcns(job_id)       WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_pcns_org       ON pcns(client_organisation_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_pcns_status    ON pcns(status)       WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_pcns_reference ON pcns(reference)    WHERE is_deleted = false;

-- ── PCN event timeline ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pcn_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pcn_id      UUID NOT NULL REFERENCES pcns(id) ON DELETE CASCADE,
  event_type  VARCHAR(30) NOT NULL,   -- created/extracted/matched/status_change/email_sent/
                                       -- receipt_chase/receipt_received/handling_charged/
                                       -- liability_transferred/comment
  body        TEXT,
  metadata    JSONB,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcn_events_pcn ON pcn_events(pcn_id, created_at);

-- ── Settings (replaces the Monday PCN Settings board) ─────────────────────────
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('pcn_handling_charge',         '35',    'PCN handling charge (£, ex-VAT)',            'pcn', 'text', 10),
  ('pcn_vat_rate',                '20',    'VAT rate (%)',                              'pcn', 'text', 20),
  ('pcn_receipt_chase_days',      '3,5,7', 'Pay-direct receipt chase days (comma-sep)', 'pcn', 'text', 30),
  ('pcn_pay_direct_hours',        '48',    'Pay-direct deadline (hours)',               'pcn', 'text', 40),
  ('pcn_police_nip_urgency_days', '5',     'Police NIP urgency window (days)',          'pcn', 'text', 50),
  ('pcn_hh_charge_item',          'b1744', 'HireHop PCN handling charge item id',       'pcn', 'text', 60)
ON CONFLICT (key) DO NOTHING;
