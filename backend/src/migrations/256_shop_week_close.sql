-- ============================================================================
-- 256: Shop sales — the weekly close
-- ============================================================================
-- docs/SHOP-SALES-SPEC.md §20. A finished week's shop job is invoiced (all
-- lines, dated the week's Sunday), every payment on it is allocated to that
-- invoice, and the job is set to Completed — by jon, from the till's
-- "This week" tab (services/shop-close.ts).
--
-- The close is resumable: each step records where it got to, so a HireHop or
-- Xero wobble half-way never creates a second invoice or allocates a payment
-- twice. HireHop's own billing rows stay authoritative for what's allocated;
-- these columns only say which invoice is OURS and how far we got.
-- ============================================================================

ALTER TABLE shop_sale_periods
  -- The invoice the close created. Once set, the close never creates another.
  ADD COLUMN IF NOT EXISTS hh_invoice_id      INTEGER,
  -- "OT-INV-12245" — only exists once approved (drafts have no number).
  ADD COLUMN IF NOT EXISTS hh_invoice_number  TEXT,
  -- NULL = not started. drafted → approved → allocated → completed.
  -- An empty week goes straight to completed with no invoice.
  ADD COLUMN IF NOT EXISTS close_state        TEXT
    CHECK (close_state IN ('drafted', 'approved', 'allocated', 'completed')),
  -- One entry per step attempted: { at, step, ok, detail }.
  ADD COLUMN IF NOT EXISTS close_log          JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS closed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by          UUID REFERENCES users(id);
