-- 345_goodwill_credits.sql
-- Goodwill credit (jon, 16 Nov 2026 — docs/GOODWILL-CREDIT-SPEC.md, phase 1).
--
-- A PROMISE, not money: "£X + VAT off your next hire (or what you owe), use by …".
-- Nothing moves in HireHop or Xero when one is offered. Staff apply it by hand in
-- HireHop (a discount on the line it's for, or a credit note) with the GW code in
-- the line's note / the credit note's description; OP never writes it to HireHop.
--
-- Held by an organisation (the band, else the client) OR a person (a client with no
-- org) — exactly one, the same shape as artist_endorsements (mig 290).
--
-- Stored statuses: offered · reserved · used · withdrawn. Two things are DERIVED on
-- read, never stored (services/goodwill-credits.ts `effectiveStatusSql()`):
--   - expired: offered and past expires_on;
--   - a credit reserved for a HIRE on a job that has since gone lost / cancelled
--     reads as offered again (a credit reserved against an INVOICE stays reserved —
--     a cancelled job still owes its fee invoice).
-- Never deleted (soft-cancel convention). Read and written ONLY through
-- services/goodwill-credits.ts.

CREATE SEQUENCE IF NOT EXISTS goodwill_credit_ref_seq START 1;

CREATE TABLE IF NOT EXISTS goodwill_credits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GW-0001 … — printed in HireHop and on the client's email, so never reused.
  ref                    VARCHAR(20) NOT NULL UNIQUE
                           DEFAULT ('GW-' || lpad(nextval('goodwill_credit_ref_seq')::text, 4, '0')),
  organisation_id        UUID REFERENCES organisations(id),
  person_id              UUID REFERENCES people(id),
  amount_ex_vat          NUMERIC(10,2) NOT NULL CHECK (amount_ex_vat > 0),
  reason                 TEXT NOT NULL,
  source_kind            VARCHAR(20) NOT NULL
                           CHECK (source_kind IN ('close_out', 'problem', 'cancellation', 'organisation', 'person')),
  source_job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
  source_issue_id        UUID REFERENCES job_issues(id) ON DELETE SET NULL,
  offered_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  offered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_on             DATE NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'offered'
                           CHECK (status IN ('offered', 'reserved', 'used', 'withdrawn')),
  -- Where it is held / was used
  reserved_job_id        UUID REFERENCES jobs(id) ON DELETE SET NULL,
  reserved_for           VARCHAR(10) CHECK (reserved_for IN ('hire', 'invoice')),
  reserved_invoice_number VARCHAR(40),
  reserved_amount_ex_vat NUMERIC(10,2),
  reserved_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  reserved_at            TIMESTAMPTZ,
  used_amount_ex_vat     NUMERIC(10,2),
  used_at                TIMESTAMPTZ,
  used_by                UUID REFERENCES users(id) ON DELETE SET NULL,
  used_how               VARCHAR(20) CHECK (used_how IN ('line', 'credit_note', 'manual')),
  used_hh_ref            VARCHAR(60),
  withdrawn_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at           TIMESTAMPTZ,
  withdrawn_reason       TEXT,
  -- Phase 2 (the HireHop read-back) fills these; unused in phase 1.
  last_checked_at        TIMESTAMPTZ,
  check_problem          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT goodwill_credits_one_owner CHECK ((person_id IS NULL) <> (organisation_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_goodwill_credits_org    ON goodwill_credits(organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goodwill_credits_person ON goodwill_credits(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goodwill_credits_job    ON goodwill_credits(reserved_job_id) WHERE reserved_job_id IS NOT NULL;
