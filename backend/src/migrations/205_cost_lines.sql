-- ============================================================================
-- 205: cost_lines — one payable, N lines
--
-- A single invoice often covers several different things: a freelancer bills
-- £325 that is really £250 of driver fee, £60 of fuel and £15 of train fare.
-- Today that is one cost with one category and one VAT rate, so whichever
-- category staff pick, the rest is quietly wrong — in the job's cost buckets,
-- on the Xero bill, and (worst) in the VAT.
--
-- Lines break the payable up. Each carries its own gross, VAT, Xero account
-- code and optionally its own job.
--
-- THE VAT POINT. resolveLineTaxType derives a rate from the header as
-- round(vat / net * 100). On the £325 example that is round(10 / 315 * 100) =
-- 3% — a blend, not a real rate. No Xero tax type matches 3%, so we send no
-- TaxType at all and Xero falls back to the account's own default. Only a
-- homogeneous line can carry a true rate, which is why amount_vat lives here
-- and not only on the header.
--
-- The header stays authoritative: costs.amount_gross / amount_vat are what we
-- owe. Lines only describe how that total breaks down and must sum back to it
-- (within 1p, checked in the API). A cost with NO lines behaves exactly as it
-- always has — there is no backfill and none is wanted.
--
-- See docs/COST-LINES-SPEC.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cost_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id           UUID NOT NULL REFERENCES costs(id) ON DELETE CASCADE,

  -- Display order, 1-based. Rewritten on every save (the API replaces the whole
  -- set), so it never needs patching in place.
  line_no           SMALLINT NOT NULL,

  description       TEXT,
  amount_gross      NUMERIC(12,2) NOT NULL,
  amount_vat        NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- NULL means INHERIT the cost's value, not "unknown". Keeps the common shape
  -- short: two lines on a freelancer invoice need only an amount and a code.
  xero_account_code VARCHAR(20),
  job_id            UUID REFERENCES jobs(id),

  -- The crew laid this out and reclaims it. A fact about WHO PAID, which no
  -- Xero account code carries — a freelancer's £40 parking receipt is coded 411
  -- exactly like parking on the company card. This is what lets the Money tab
  -- show a real "Fronted expenses" actual against the quote's expected figure.
  crew_fronted      BOOLEAN NOT NULL DEFAULT FALSE,

  -- Typed by a human, or proposed by the receipt AI. Kept so we can tell later
  -- whether AI splitting is worth having.
  source            VARCHAR(10) NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'ai')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (cost_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_cost_lines_cost ON cost_lines (cost_id);
CREATE INDEX IF NOT EXISTS idx_cost_lines_job  ON cost_lines (job_id) WHERE job_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_cost_lines_updated_at ON cost_lines;
CREATE TRIGGER trg_cost_lines_updated_at
  BEFORE UPDATE ON cost_lines
  FOR EACH ROW EXECUTE FUNCTION costs_touch_updated_at();
