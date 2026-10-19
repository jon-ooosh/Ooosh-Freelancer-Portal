-- ============================================================================
-- 210: supplier_aliases — remember which Xero contact a printed name means
--
-- The receipt AI reads the name as PRINTED on the document; Xero holds the name
-- as the bookkeeper typed it. "High Class-Cleaning LTD" on the letterhead is
-- "High Class Cleaning" in Xero, and the old match (lowercase + substring
-- containment) saw no relation between the two — so OP offered to create a
-- second contact for a supplier we already had.
--
-- Normalising both sides catches most of that (see normaliseSupplierName). It
-- will never catch the rest: a trading name that differs from the registered
-- one, a garage whose invoices come from its parent company, an abbreviation.
-- Those need a human to say "yes, that one" ONCE — and this table is what
-- remembers it, so nobody is ever asked twice.
--
-- Keyed on the NORMALISED printed name, so trivial variations of the same
-- letterhead (punctuation, case, a "Ltd" gained or lost) all hit one row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS supplier_aliases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- normaliseSupplierName(printed name) — lowercase, punctuation stripped,
  -- company suffixes removed. THE lookup key.
  alias_key       VARCHAR(200) NOT NULL UNIQUE,
  -- What was actually printed, kept for display ("we read this as…").
  printed_name    VARCHAR(200) NOT NULL,
  xero_contact_id VARCHAR(60)  NOT NULL,
  xero_name       VARCHAR(200) NOT NULL,
  confirmed_by    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Bumped on every hit, so we can see whether this is earning its keep.
  hit_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_supplier_aliases_contact ON supplier_aliases (xero_contact_id);
