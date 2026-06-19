-- 139_supplier_payment_terms.sql
-- Supplier payment terms → real bill due dates (EOM-aware), replacing the flat
-- invoice + 30 assumption. See docs/COSTS-PAYMENT-AUTOMATION-SPEC.md (Part 1).
--
-- Two pieces:
--   1. costs.xero_contact_id — captured when staff pick a real Xero supplier in
--      the capture modal (we already fetch it for the autocomplete, then threw
--      it away). Lets terms resolve by stable contact id, and seeds terms from
--      the Xero contact's PaymentTerms.Bills.
--   2. supplier_payment_terms — one row per supplier (keyed by Xero contact id
--      when known, else lowercased name). basis + days model the term; source
--      records whether it came from Xero or a manual override.

ALTER TABLE costs ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

CREATE TABLE IF NOT EXISTS supplier_payment_terms (
  -- 'xero:<contactId>' when a Xero contact id is known, else 'name:<lower(name)>'.
  term_key        TEXT PRIMARY KEY,
  supplier_name   VARCHAR(200),
  xero_contact_id TEXT,
  basis           VARCHAR(24) NOT NULL DEFAULT 'invoice_date'
                    CHECK (basis IN ('invoice_date', 'end_of_invoice_month')),
  days            INTEGER NOT NULL DEFAULT 30 CHECK (days >= 0 AND days <= 365),
  source          VARCHAR(12) NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'xero')),
  updated_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
