-- 332: Cash forecast, Phase 3 (docs/CASHFLOW-FORECAST-SPEC.md §13.3, Nov 2026).
--
-- 1. Wise can be read live (a read-only Wise API token): the account becomes
--    kind 'wise', like Stripe's 'stripe'. When the token isn't set or Wise
--    can't be read, it is typed on the Monday check-in as before.
-- 2. Regular-payment suggestions from Xero's bank history: a supplier jon says
--    "not this one" to is remembered here, so it isn't suggested again.
ALTER TABLE cashflow_accounts DROP CONSTRAINT IF EXISTS cashflow_accounts_kind_check;
ALTER TABLE cashflow_accounts ADD CONSTRAINT cashflow_accounts_kind_check
  CHECK (kind IN ('bank', 'savings', 'cash', 'stripe', 'wise'));

UPDATE cashflow_accounts SET kind = 'wise'
 WHERE name = 'Wise' AND kind = 'bank'
   AND NOT EXISTS (SELECT 1 FROM cashflow_accounts WHERE kind = 'wise');

CREATE TABLE IF NOT EXISTS cashflow_recurring_dismissed (
  xero_contact_id  VARCHAR(100) PRIMARY KEY,
  contact_name     VARCHAR(200),
  dismissed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
