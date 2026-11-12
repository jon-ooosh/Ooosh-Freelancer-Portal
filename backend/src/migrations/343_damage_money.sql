-- ============================================================================
-- 343: damage money — one Money card for Problems and insurance claims
-- ============================================================================
-- docs/INCIDENT-CLAIMS-SPEC.md §23. The money around a piece of damage was in
-- four places and none of them on the claim page. Most of it stays where it
-- is and is only READ by the new card:
--   - the estimate: job_issues.estimated_cost (a Problem) or the broker form's
--     form_data.our_vehicle.repair_cost (a claim) — both ex VAT from now on
--   - what we spent: costs rows linked by costs.job_issue_id (Money › Costs)
--   - what the client's excess paid: job_excess.claim_amount (the Money tab)
--
-- This table holds the two things that had nowhere to live:
--   - client_recovery: what we charged the client FOR THIS damage — from the
--     excess, on an invoice, or some other way. Typed by a person, because
--     OP cannot tell which part of a kept excess paid for which damage
--     (£1,200 for the bumper + £100 fuel + £60 carpet all sit in one total).
--   - insurer_payment: what the insurer paid, to us or straight to the
--     repairer (a letter of authorisation). Claims only.
--
-- Amounts are entered like Costs — net, VAT, gross — and always stored all
-- three. Nothing here moves money: excess, invoices and bills still go
-- through the Money tab and Money › Costs.
--
-- A line belongs to a Problem OR a claim, never both. Removing a line only
-- stamps deleted_at — it records what someone said happened to money.
-- ============================================================================

CREATE TABLE IF NOT EXISTS damage_money_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id      UUID REFERENCES job_issues(id),
  claim_id      UUID REFERENCES incident_claims(id),
  kind          VARCHAR(20) NOT NULL,
  -- client_recovery: how the client paid it
  source        VARCHAR(20),
  -- insurer_payment: who the insurer paid
  paid_to       VARCHAR(20),
  description   TEXT,
  amount_net    NUMERIC(12,2) NOT NULL,
  amount_vat    NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_gross  NUMERIC(12,2) NOT NULL,
  entry_date    DATE,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  deleted_by    UUID REFERENCES users(id),

  CONSTRAINT damage_money_lines_owner_check
    CHECK ((issue_id IS NULL) <> (claim_id IS NULL)),
  CONSTRAINT damage_money_lines_kind_check
    CHECK (kind IN ('client_recovery', 'insurer_payment')),
  CONSTRAINT damage_money_lines_source_check
    CHECK (source IS NULL OR source IN ('excess', 'invoice', 'other')),
  CONSTRAINT damage_money_lines_paid_to_check
    CHECK (paid_to IS NULL OR paid_to IN ('ooosh', 'repairer')),
  CONSTRAINT damage_money_lines_shape_check
    CHECK (
      (kind = 'client_recovery' AND source IS NOT NULL AND paid_to IS NULL)
      OR (kind = 'insurer_payment' AND claim_id IS NOT NULL AND paid_to IS NOT NULL AND source IS NULL)
    ),
  CONSTRAINT damage_money_lines_amounts_check
    CHECK (amount_net >= 0 AND amount_vat >= 0 AND amount_gross >= 0
           AND ABS(amount_gross - amount_net - amount_vat) < 0.015)
);

CREATE INDEX IF NOT EXISTS idx_damage_money_lines_issue
  ON damage_money_lines (issue_id) WHERE issue_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_damage_money_lines_claim
  ON damage_money_lines (claim_id) WHERE claim_id IS NOT NULL AND deleted_at IS NULL;

-- "How was it resolved?" is now required to resolve a Problem; "Other" needs
-- a note, and this is where it lives.
ALTER TABLE job_issues ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- A letter of authorisation (the insurer pays the bodyshop directly) is filed
-- on the claim like any other document. Private by default, like the rest.
ALTER TABLE incident_claim_files DROP CONSTRAINT IF EXISTS incident_claim_files_file_type_check;
ALTER TABLE incident_claim_files ADD CONSTRAINT incident_claim_files_file_type_check
  CHECK (file_type IN ('photo', 'police_report', 'broker_correspondence', 'repair_quote', 'tts360_notice',
                       'gps_trace', 'authorisation_letter', 'other'));
