-- Edit-after-push tracking. When a cost that has already been pushed to Xero is
-- edited with a field that affects the Xero object (amount, account code,
-- supplier, date, etc.), OP can't silently re-push (the object may be reconciled).
-- Instead we flag it stale so the UI can warn + offer a manual "Re-sync to Xero".
-- Cleared on a successful re-sync.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS xero_stale BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN costs.xero_stale IS
  'TRUE when a Xero-pushed cost was edited with a Xero-affecting field; cleared on successful re-sync.';
