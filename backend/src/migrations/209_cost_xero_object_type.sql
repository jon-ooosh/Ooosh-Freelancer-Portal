-- ============================================================================
-- 209: costs.xero_object_type — what we actually created in Xero
--
-- TWO live bugs share one root cause: OP knew a cost had a Xero object, but not
-- reliably WHETHER it existed or WHAT KIND it was.
--
-- 1. DUPLICATE BILLS. Every "is this already in Xero?" guard read
--      xero_object_id IS NOT NULL *AND* xero_sync_state IN (pushed states)
--    but recordError() sets state='error' and leaves xero_object_id alone. So a
--    cost with a live Xero bill whose last operation merely FAILED read as "not
--    in Xero", and the next push created a second one. Re-sync was the worst
--    offender: its first line fell through to the create path on any non-pushed
--    state, so pressing "Re-sync to Xero" on an errored cost duplicated it.
--    Fixed in code: existence is decided by xero_object_id ALONE. State says
--    whether the last operation succeeded; it never says whether the object is
--    there.
--
-- 2. WRONG ENTITY ON RE-SYNC. A cost paid now becomes a Xero BankTransaction; a
--    cost paid later becomes an Invoice. Re-sync re-derived which from the
--    cost's CURRENT payment_method, so changing the method after the push sent
--    an Invoice id to the BankTransactions endpoint (or the reverse). That is
--    exactly the live error on three rows today:
--      "The specified BankTransactionID does not match a known bank transaction"
--      "An existing Invoice with the specified Type and InvoiceID could not be found"
--    This column records what was really created, so re-sync targets it.
--
-- Backfill uses the same payment-method guess the code used to make, which is
-- right for every cost whose method hasn't changed since the push — i.e. all but
-- the handful this fixes. Those few are repaired by re-syncing once deployed.
-- ============================================================================

ALTER TABLE costs ADD COLUMN IF NOT EXISTS xero_object_type VARCHAR(20)
  CHECK (xero_object_type IS NULL OR xero_object_type IN ('invoice', 'banktransaction'));

COMMENT ON COLUMN costs.xero_object_type IS
  'Which Xero entity xero_object_id refers to: invoice (Bill) or banktransaction (Spend Money). Set at creation; NULL on legacy rows falls back to a payment_method guess.';

-- Best-effort backfill for rows already in Xero. BILL_METHODS in
-- services/cost-xero-push.ts is the source of truth for this split — keep in step.
UPDATE costs SET xero_object_type =
  CASE WHEN payment_method IN ('not_yet_paid', 'reimburse_me')
       THEN 'invoice' ELSE 'banktransaction' END
WHERE xero_object_id IS NOT NULL AND xero_object_type IS NULL;
