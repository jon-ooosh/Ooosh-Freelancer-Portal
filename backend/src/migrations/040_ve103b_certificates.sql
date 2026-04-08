-- Migration 040: VE103B Certificate tracking
-- Replaces Google Sheets log for BVRLA monthly reporting.
-- Each row = one physical VE103B certificate (issued or voided).

CREATE TABLE IF NOT EXISTS ve103b_certificates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_number    VARCHAR(20) NOT NULL,
  assignment_id         UUID REFERENCES vehicle_hire_assignments(id),
  vehicle_id            UUID REFERENCES fleet_vehicles(id),
  driver_id             UUID REFERENCES drivers(id),
  job_id                UUID REFERENCES jobs(id),

  -- Snapshot of data at time of generation (for BVRLA report & audit)
  vehicle_reg           VARCHAR(20) NOT NULL,
  driver_name           VARCHAR(200) NOT NULL,
  driver_address        TEXT,
  hire_start            DATE,
  hire_end              DATE,
  hirehop_job_number    INTEGER,

  -- Certificate lifecycle
  status                VARCHAR(20) NOT NULL DEFAULT 'issued',
  void_reason           TEXT,
  voided_at             TIMESTAMPTZ,
  voided_by             UUID REFERENCES users(id),

  -- PDF storage
  pdf_r2_key            VARCHAR(500),
  pdf_filename          VARCHAR(200),

  -- BVRLA report fields
  bvrla_member_number   VARCHAR(20) NOT NULL DEFAULT '10864',
  date_certificate_supplied DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Metadata
  generated_by          UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Certificate number must be unique (each physical form has a unique serial)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ve103b_cert_number ON ve103b_certificates(certificate_number);

-- Fast lookup for BVRLA monthly report
CREATE INDEX IF NOT EXISTS idx_ve103b_date_supplied ON ve103b_certificates(date_certificate_supplied);

-- Fast lookup by assignment and vehicle
CREATE INDEX IF NOT EXISTS idx_ve103b_assignment ON ve103b_certificates(assignment_id);
CREATE INDEX IF NOT EXISTS idx_ve103b_vehicle ON ve103b_certificates(vehicle_id);
