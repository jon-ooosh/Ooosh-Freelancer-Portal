-- ============================================================================
-- 224: Costs settled outside OP ("already paid in Xero, just clear the ledger")
-- ============================================================================
-- A bill can be paid without OP ever being told: the bookkeeper pays it in Xero
-- directly, or it is settled by some route OP has no record of. Until now the
-- only way to clear it from Bills to Pay was "Mark paid", which RECORDS A REAL
-- PAYMENT against the bill in Xero — i.e. pays a supplier twice.
--
-- Two things close that gap. The daily bill payment pull-back sync
-- (services/cost-xero-payment-sync.ts) handles the common case automatically by
-- asking Xero whether our own bill is now PAID. This column is the escape hatch
-- for everything else: settled elsewhere, no Xero bill, or the money landed on a
-- different bill someone keyed by hand.
--
-- WHY IT MUST BE PERSISTED, not a one-off "skip the push this time":
--   `payment_status = 'paid'` + `xero_payment_id IS NULL` + a bill in Xero is
--   the exact condition THREE code paths read as "this bill still needs its
--   payment recording in Xero" (the push service's step 2, the background push
--   fired by any cost edit, and the Push now / Retry button). Without a flag on
--   the row, the next person to edit the description would silently pay the
--   supplier again. Every one of those paths now checks this column.
-- ============================================================================

-- Settled outside OP: clear the ledger locally, never record a payment in Xero.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS settled_externally BOOLEAN NOT NULL DEFAULT FALSE;

-- Why — required at the point of use. "Paid on Jon's card in June", "already
-- paid in Xero against bill INV-1042". Without it the ledger is clean and
-- nobody can tell whether the money actually moved.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS settled_externally_note TEXT;

COMMENT ON COLUMN costs.settled_externally IS
  'Cleared from the OP ledger without OP paying it. Suppresses the Xero payment leg on every push path.';
COMMENT ON COLUMN costs.settled_externally_note IS
  'Staff-supplied reason a cost was settled outside OP (required when the flag is set).';
