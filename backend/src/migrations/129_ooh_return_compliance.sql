-- Migration 129: Out-of-Hours return compliance tracking (Part 2)
--
-- Per-driver record of inconsiderate OOH returns + a block flag that removes a
-- repeat offender's ability to return OOH. Detection is a STAFF decision made at
-- van check-in (and retro-flaggable later) — never automated. See Part 2 of
-- docs/OOH-SMS-AND-COMPLIANCE-SPEC.md.

CREATE TABLE IF NOT EXISTS ooh_return_violations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      UUID REFERENCES drivers(id),                    -- nullable until attributed
  assignment_id  UUID REFERENCES vehicle_hire_assignments(id),
  job_id         UUID REFERENCES jobs(id),
  vehicle_id     UUID REFERENCES fleet_vehicles(id),
  occurred_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  type           VARCHAR(40)  NOT NULL,                           -- parked_blocking | parked_outside_yard | left_without_telling_us | other
  severity       VARCHAR(20)  NOT NULL DEFAULT 'serious',         -- minor | serious
  notes          TEXT,
  logged_by      UUID REFERENCES users(id),
  dismissed      BOOLEAN NOT NULL DEFAULT FALSE,                  -- clear a mis-attribution without losing the row
  dismiss_reason TEXT,
  dismissed_by   UUID REFERENCES users(id),
  dismissed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ooh_violations_driver
  ON ooh_return_violations(driver_id) WHERE dismissed = FALSE;
CREATE INDEX IF NOT EXISTS idx_ooh_violations_job ON ooh_return_violations(job_id);

-- Eligibility flag on the driver (the SOURCE OF TRUTH for "can this person return
-- OOH?"). Set via the suggest-and-confirm flow once the threshold is crossed.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS ooh_blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ooh_blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ooh_blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS ooh_blocked_by     UUID REFERENCES users(id);

-- How many non-dismissed violations before the system suggests a block (the block
-- itself is always human-confirmed, never auto-applied).
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES ('ooh_violation_block_threshold', '2', 'OOH violations before suggesting a block', 'ooh_returns', 'text', 120)
ON CONFLICT (key) DO NOTHING;
