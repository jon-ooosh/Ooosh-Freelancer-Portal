-- Migration 104: Vehicle finance & lifecycle (acquisition → finance → disposal)
--
-- Extends the fleet_vehicles "lifespan" story so admins can track the full
-- financial life of a van: what we paid/financed (acquisition cost breakdown),
-- who the finance is with + its reference + start/end dates, the derived
-- 5-years-from-first-registration sell window (computed at render, NOT stored),
-- and the disposal record (sale date/price/notes) captured when a van is sold.
--
-- Also adds a "removal checklist" mirroring the existing setup_checklist
-- (migration 091) — the off-system jobs that are easy to forget when a van
-- leaves the fleet (remove from HireHop / TTS360 / insurers, notify DVLA, and
-- the DVLA confirmation that lands 1–2 weeks later). The checklist is seeded
-- when a vehicle is marked sold and stays editable afterwards.
--
-- Finance fields are ADMIN-ONLY (gated in the API). The removal checklist is
-- operational and visible to all staff.

ALTER TABLE fleet_vehicles
  -- Finance details (admin-only)
  ADD COLUMN IF NOT EXISTS finance_start       DATE,
  ADD COLUMN IF NOT EXISTS finance_reference   TEXT,
  -- Finance agreement figures (admin-only). "Total payable" + "cost of finance"
  -- are DERIVED at render (not stored): total = deposit + monthly×term + fees;
  -- cost of finance = total − cash_price. For an outright-owned van, leave the
  -- finance figures blank and cash_price IS the total cost.
  ADD COLUMN IF NOT EXISTS cash_price          NUMERIC(12,2),  -- inc-VAT cash price of the van
  ADD COLUMN IF NOT EXISTS deposit_paid        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS amount_financed     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS monthly_payment     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS finance_term_months INTEGER,
  -- Fees as a JSONB array of { label, amount } so different agreements can add
  -- their own (acceptance, option-to-purchase, doc fees, etc.). Summed at render.
  ADD COLUMN IF NOT EXISTS finance_fees        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Disposal record (admin-only)
  ADD COLUMN IF NOT EXISTS sold_date         DATE,
  ADD COLUMN IF NOT EXISTS sale_price        NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS sale_notes        TEXT,
  -- Removal checklist (all-staff). Shape mirrors setup_checklist:
  -- JSONB array of { key, label, done, doneAt, doneBy }. Empty = not started.
  ADD COLUMN IF NOT EXISTS removal_checklist JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed the finance-provider picklist with the labels carried over from the
-- Monday Fleet board. Staff can add ad-hoc providers from the finance picker
-- (writes more rows into this same category). value = label (the vehicle's
-- finance_with column stores the human label as free text).
INSERT INTO picklist_items (category, value, label, sort_order) VALUES
  ('finance_provider', 'We own outright',            'We own outright',            0),
  ('finance_provider', 'Leased',                     'Leased',                     1),
  ('finance_provider', 'Propel',                     'Propel',                     10),
  ('finance_provider', 'Haydock',                    'Haydock',                    11),
  ('finance_provider', 'Carrick Asset',              'Carrick Asset',              12),
  ('finance_provider', 'Corporate Asset Solutions',  'Corporate Asset Solutions',  13),
  ('finance_provider', 'Close Bros',                 'Close Bros',                 14),
  ('finance_provider', 'Renaissance Asset Finance',  'Renaissance Asset Finance',  15),
  ('finance_provider', 'Interbay',                    'Interbay',                  16),
  ('finance_provider', 'BNP Paribas',                'BNP Paribas',                17),
  ('finance_provider', 'Mercedes Finance',           'Mercedes Finance',           18)
ON CONFLICT (category, value) DO NOTHING;
