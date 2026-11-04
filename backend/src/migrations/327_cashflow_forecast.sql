-- 327: Cash forecast, Phase 1 (docs/CASHFLOW-FORECAST-SPEC.md, Nov 2026).
--
-- An admin-only 13-week cash forecast. Everything here is ADMIN ONLY, which is
-- why the settings live in their own table and NOT in system_settings: every
-- staff login can read system_settings (routes/system-settings.ts), and the
-- YouLend balance, the overdraft and the card figures are not for everyone.
--
-- Nothing here is a money record. These rows are jon's own planning inputs
-- (balances he typed on a Monday, payments he expects), so plain deletes are
-- fine — the soft-cancel rule is for the hire-tracking chain.

-- ── Settings (key/value, admin only) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cashflow_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO cashflow_settings (key, value) VALUES
  ('target_floor',            '0'),           -- the line jon aims to stay above (£)
  ('overdraft_limit',         '22000'),       -- the Lloyds overdraft (£, positive)
  ('youlend_rate',            '0.28'),        -- share of Stripe receipts withheld
  ('youlend_remaining',       '152671'),      -- £ still owed, from the YouLend statement
  ('youlend_as_of',           '2026-11-04'),  -- when that figure was read
  ('stripe_share',            '0.90'),        -- share of money in that comes through Stripe
  ('stripe_fee_rate',         '0.015'),       -- used when Stripe's own figures can't be read
  ('stripe_payout_days',      '2'),           -- working days from payment to spendable
  ('excess_refund_days',      '7'),           -- days after the return that excess goes back
  ('count_overdue_bills',     'false'),       -- put the overdue-bill pile in from next week
  ('count_overdue_balances',  'false'),       -- put overdue client balances in from next week
  ('suggest_bank_transfer',   'true')         -- Phase 2 fix-it list (YouLend agreement allows it)
ON CONFLICT (key) DO NOTHING;

-- ── Where the cash is ───────────────────────────────────────────────────────
-- kind: bank / savings / cash (counted, typed in on a Monday) or stripe (read
-- live from Stripe when the key allows; typed in otherwise).
CREATE TABLE IF NOT EXISTS cashflow_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  kind        VARCHAR(20) NOT NULL CHECK (kind IN ('bank', 'savings', 'cash', 'stripe')),
  is_main     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cashflow_accounts (name, kind, is_main, sort_order)
SELECT v.name, v.kind, v.is_main, v.sort_order
FROM (VALUES
  ('Lloyds',                          'bank',    TRUE,  10),
  ('Wise',                            'bank',    FALSE, 20),
  ('Stripe',                          'stripe',  FALSE, 30),
  ('Savings (Virgin, Aldermore, CoT savings, Moneybox)', 'savings', FALSE, 40),
  ('Cash on site (petty cash + till)', 'cash',   FALSE, 50)
) AS v(name, kind, is_main, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM cashflow_accounts);

-- ── Cards ───────────────────────────────────────────────────────────────────
-- A balance is what is OWED on the card (positive). Purchases on a card are not
-- cash out; the plan's payments are. Interest is added to the card, not paid in
-- cash on its own, so the page shows it as a memo, never in the totals.
CREATE TABLE IF NOT EXISTS cashflow_cards (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(100) NOT NULL,
  monthly_rate           NUMERIC(7,5) NOT NULL DEFAULT 0,   -- 0.0183 = 1.83% a month; 0 for a charge card
  statement_day          INTEGER CHECK (statement_day BETWEEN 1 AND 31),
  payment_day            INTEGER CHECK (payment_day BETWEEN 1 AND 31),
  credit_limit           NUMERIC(12,2),
  plan                   VARCHAR(10) NOT NULL DEFAULT 'full' CHECK (plan IN ('full', 'minimum', 'fixed')),
  min_pct                NUMERIC(5,2),                       -- minimum payment, % of the balance
  fixed_amount           NUMERIC(12,2),
  fixed_every            VARCHAR(5) CHECK (fixed_every IN ('week', 'month')),
  fixed_weekday          INTEGER CHECK (fixed_weekday BETWEEN 1 AND 7),  -- 1 = Monday
  typical_monthly_spend  NUMERIC(12,2),                      -- typed; used for the balance line and "in full" payments
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cashflow_cards (name, monthly_rate, statement_day, payment_day, credit_limit, plan, min_pct, fixed_amount, fixed_every, fixed_weekday, sort_order)
SELECT v.* FROM (VALUES
  ('Capital on Tap', 0.0183::NUMERIC, 27, 3,  45000::NUMERIC, 'fixed', 10::NUMERIC,   1000::NUMERIC, 'week', 1, 10),
  ('Amex Gold',      0::NUMERIC,      3,  23, NULL::NUMERIC,  'full',  NULL::NUMERIC, NULL::NUMERIC, NULL,   NULL::INTEGER, 20)
) AS v(name, monthly_rate, statement_day, payment_day, credit_limit, plan, min_pct, fixed_amount, fixed_every, fixed_weekday, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM cashflow_cards);

-- ── The Monday check-in ─────────────────────────────────────────────────────
-- One row per account or card per check-in. The latest row per account/card is
-- the opening balance.
CREATE TABLE IF NOT EXISTS cashflow_balance_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID REFERENCES cashflow_accounts(id) ON DELETE CASCADE,
  card_id     UUID REFERENCES cashflow_cards(id) ON DELETE CASCADE,
  balance     NUMERIC(12,2) NOT NULL,
  as_of       DATE NOT NULL,
  entered_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((account_id IS NULL) <> (card_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_cashflow_snapshots_account ON cashflow_balance_snapshots (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashflow_snapshots_card ON cashflow_balance_snapshots (card_id, created_at DESC);

-- ── Planned items — the one place for anything Xero doesn't schedule ────────
-- Either a RULE (amount, frequency, start, end) or a SCHEDULE (rows in
-- cashflow_planned_item_dates). Optional links:
--   xero_contact_id — "matches bills from": a Xero bill from this supplier near a
--                     planned date replaces that occurrence (never counted twice)
--   xero_bill_id    — "instalments of this bill": the bill leaves the bills line
--                     and the schedule takes over
CREATE TABLE IF NOT EXISTS cashflow_planned_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label              VARCHAR(200) NOT NULL,
  category           VARCHAR(20) NOT NULL DEFAULT 'overheads'
                       CHECK (category IN ('overheads', 'payroll', 'vat', 'tax', 'instalments', 'one_off', 'income', 'other')),
  direction          VARCHAR(3) NOT NULL DEFAULT 'out' CHECK (direction IN ('in', 'out')),
  kind               VARCHAR(10) NOT NULL CHECK (kind IN ('rule', 'schedule')),
  amount             NUMERIC(12,2),
  frequency          VARCHAR(10) CHECK (frequency IN ('once', 'weekly', 'monthly', 'quarterly', 'yearly')),
  start_date         DATE,
  end_date           DATE,
  expected_total     NUMERIC(12,2),      -- a schedule's typed total when there is no Xero bill
  xero_contact_id    VARCHAR(100),
  xero_contact_name  VARCHAR(200),
  xero_bill_id       VARCHAR(100),
  xero_bill_label    VARCHAR(200),
  notes              TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind <> 'rule' OR (amount IS NOT NULL AND frequency IS NOT NULL AND start_date IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS cashflow_planned_item_dates (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id   UUID NOT NULL REFERENCES cashflow_planned_items(id) ON DELETE CASCADE,
  due_date  DATE NOT NULL,
  amount    NUMERIC(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cashflow_planned_dates_item ON cashflow_planned_item_dates (item_id, due_date);

-- ── Xero bills: what jon has said about them ────────────────────────────────
--   paid_xero_behind — paid, the bookkeeper hasn't reconciled it yet. Drops out of
--                      the forecast; harmless once Xero marks it paid.
--   paid_by_card     — paid on a card, so it is cash out when the card is paid.
--   ignore           — not a real outgoing (a duplicate, a mistake in Xero).
-- Never written to Xero.
CREATE TABLE IF NOT EXISTS cashflow_bill_flags (
  xero_invoice_id  VARCHAR(100) PRIMARY KEY,
  flag             VARCHAR(20) NOT NULL CHECK (flag IN ('paid_xero_behind', 'paid_by_card', 'ignore')),
  bill_label       VARCHAR(300),
  set_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  set_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every bill from these suppliers is left out (e.g. a van HP lender, whose
-- payments come from the fleet finance records instead).
CREATE TABLE IF NOT EXISTS cashflow_excluded_contacts (
  xero_contact_id  VARCHAR(100) PRIMARY KEY,
  contact_name     VARCHAR(200),
  reason           TEXT,
  set_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  set_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
