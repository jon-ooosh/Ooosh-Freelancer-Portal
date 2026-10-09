-- ============================================================================
-- 197: Cost due date — staff override
--
-- The bill due date has always been DERIVED at read time (supplier payment
-- terms, or the Ooosh freelancer Friday rule) and never stored anywhere. That
-- stays the default, but staff now see it at capture time and can correct it:
-- an invoice that prints its own due date, or a one-off arrangement with a
-- supplier that isn't worth changing their standing terms for.
--
-- NULL = follow the derived rule. A value here ALWAYS wins, on every surface
-- (costs list, get-one, mark-paid modal, Xero bill push, Xero re-sync) via
-- services/supplier-terms.ts `resolveDueDate()`. Never read this column raw —
-- that's how the surfaces would drift apart again.
-- ============================================================================

ALTER TABLE costs ADD COLUMN IF NOT EXISTS due_date_override DATE;

COMMENT ON COLUMN costs.due_date_override IS
  'Staff-set bill due date. NULL = derive from supplier terms / the freelancer Friday rule. Always read via resolveDueDate().';
