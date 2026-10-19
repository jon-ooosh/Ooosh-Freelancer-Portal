-- ============================================================================
-- 238: Shop sales — the transaction ledger behind the till
-- ============================================================================
-- Step 4 of docs/SHOP-SALES-SPEC.md. THE load-bearing idea (§0): the unit of
-- truth is the TRANSACTION, not the week. Today's weekly "Shop Sales" dummy job
-- in HireHop is a shared open drawer with no receipts — multiple users, seven
-- days, no per-transaction integrity — which is why it never reconciles.
--
-- A sale here is one atomic record: lines, tender, who, when. OP writes the
-- HireHop line AND the payment as a unit, so they cannot diverge, because no
-- human performs them as two separate acts.
--
-- ⚠️ THIS MIGRATION IS THE LEDGER ONLY. Nothing drains to HireHop yet (that is
-- steps 5–6). Rows land `status = 'queued'` and sit there. When the drain ships,
-- it will pick up anything still queued — so TEST ROWS CREATED NOW MUST BE
-- CANCELLED before that deploy, or they will push real lines and real money.
-- ============================================================================

-- ── The weekly container ────────────────────────────────────────────────────
-- One HireHop "Shop Sales W/C ..." job per week, permanently at DISPATCHED (5),
-- because sale stock is only consumed at dispatch and a line added to an
-- already-dispatched job decrements immediately (§2.1, verified).
CREATE TABLE IF NOT EXISTS shop_sale_periods (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Monday of the week. UNIQUE is load-bearing: it stops two tills racing to
  -- create two HireHop jobs for the same week.
  period_start   DATE NOT NULL UNIQUE,
  period_end     DATE NOT NULL,

  hh_job_number  INTEGER,
  invoiced_at    TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── One row per transaction ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_sales (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- 'sale'        — money changes hands (or is invoiced to a job)
  -- 'consumption' — stock used by Ooosh; NO money exists. Not a 100%-discounted
  --                 sale: that makes a stock event require a money action, which
  --                 is exactly why people forget it (§2).
  -- 'reversal'    — a linked return. Both events really happened (§8).
  kind               TEXT NOT NULL CHECK (kind IN ('sale', 'consumption', 'reversal')),

  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'pushed', 'failed', 'cancelled')),

  period_id          UUID REFERENCES shop_sale_periods(id),
  reverses_sale_id   UUID REFERENCES shop_sales(id),

  hh_job_number      INTEGER,          -- shop job, or the client's own job
  hh_deposit_id      INTEGER,          -- returned by pushDepositToHH

  -- Key into HH_BANK_IDS (services/hh-deposit.ts) — worldpay, amex, till_cash,
  -- stripe_gbp, paypal, wise_bacs — or 'invoice_later'. NULL for consumption.
  -- ⚠️ 'invoice_later' is only legal when attached to a real job: the weekly
  -- shop job pools every customer, so its invoice can never go to one of them
  -- (§9).
  tender             TEXT,

  -- Money, all inclusive of the lines below. HireHop prices are EX-VAT
  -- throughout, so gross is what the customer actually hands over (§2.2).
  net_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  vat_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  gross_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Total given away vs list price, ex-VAT. Capped per role (§2.8).
  discount_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,

  recorded_by        UUID NOT NULL REFERENCES users(id),
  recorded_in        TEXT NOT NULL DEFAULT 'staff_till'
                     CHECK (recorded_in IN ('staff_till', 'sitter_till')),

  sold_to_person_id  UUID REFERENCES people(id),   -- nullable ON PURPOSE (§4.2)
  sold_to_job_id     UUID REFERENCES jobs(id),

  -- Sitter sales surface for a morning tick. Warnings, not hard gates: the
  -- stock count matters more than perfection, and the sale carries their name.
  needs_review       BOOLEAN NOT NULL DEFAULT FALSE,

  notes              TEXT,

  -- The Window A hold (§8). Until this passes, nothing has reached HireHop or
  -- Xero, so a cancel is a true undo rather than a refund.
  push_after         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pushed_at          TIMESTAMPTZ,
  push_error         TEXT,

  -- Soft-cancel, never delete (house rule). The row records something that
  -- happened, or that someone believed happened.
  cancelled_at       TIMESTAMPTZ,
  cancelled_by       UUID REFERENCES users(id),
  cancel_reason      TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_sales_period ON shop_sales (period_id);
CREATE INDEX IF NOT EXISTS idx_shop_sales_created ON shop_sales (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_sales_job ON shop_sales (sold_to_job_id)
  WHERE sold_to_job_id IS NOT NULL;
-- The drain's work queue: anything queued whose hold has expired.
CREATE INDEX IF NOT EXISTS idx_shop_sales_drain ON shop_sales (status, push_after)
  WHERE status = 'queued';
-- The morning review list.
CREATE INDEX IF NOT EXISTS idx_shop_sales_review ON shop_sales (needs_review)
  WHERE needs_review = TRUE;

-- ── The lines ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_sale_lines (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id             UUID NOT NULL REFERENCES shop_sales(id) ON DELETE CASCADE,

  hh_stock_id         INTEGER NOT NULL,   -- addressed as a<id> when pushing

  -- Snapshots, on purpose: a price change next month must not rewrite what
  -- somebody was charged, and a renamed item must not rewrite what they bought.
  name_snapshot       TEXT NOT NULL,
  unit_price_list     NUMERIC(10,2) NOT NULL,   -- ex VAT, HireHop's Price A
  unit_price_charged  NUMERIC(10,2) NOT NULL,   -- ex VAT, after any discount

  qty                 NUMERIC(10,2) NOT NULL CHECK (qty > 0),

  -- The HireHop tax-TYPE index, plus the percentage it resolved to at the time.
  -- ⚠️ The index is NOT a percentage — index 0 is the STANDARD rate (§2.2).
  -- Both are stored because the index is what HireHop needs on a push and the
  -- percentage is what the customer was actually charged.
  vat_rate_index      INTEGER,
  vat_rate_pct        NUMERIC(5,2) NOT NULL,

  line_net            NUMERIC(10,2) NOT NULL,
  line_vat            NUMERIC(10,2) NOT NULL,
  line_gross          NUMERIC(10,2) NOT NULL,

  -- Filled in by the drain. hh_line_id is the handle a Window B reversal needs
  -- (items_delete.php `ids=b<hh_line_id>`); hh_tally_id is the consumption
  -- equivalent. A line is EITHER a job line OR a tally adjustment, never both —
  -- the double-decrement trap (§2).
  hh_line_id          INTEGER,
  hh_tally_id         INTEGER,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_sale_lines_sale ON shop_sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS idx_shop_sale_lines_stock ON shop_sale_lines (hh_stock_id);

-- ── Settings ────────────────────────────────────────────────────────────────
-- Discount ceiling by role, as a percentage of the TRANSACTION total — not of a
-- single line. A per-line cap would block the rounding case: knocking £2 off a
-- £52 basket of £1 cans means discounting one can by 100%, even though the
-- customer is only getting 4% off (§2.8).
--
-- `weekend_manager` is absent deliberately — authorize() already treats it as
-- `manager`, and listing it separately is how roles drift apart.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_discount_caps',
  '{"admin":100,"manager":50,"staff":10,"general_assistant":10,"freelancer":0}',
  'Shop — max discount % by role',
  'shop',
  'json',
  30
)
ON CONFLICT (key) DO NOTHING;

-- How long a sale waits before the drain sends it to HireHop. This IS Window A
-- (§8): inside it, a cancel is a true undo because nothing has reached HireHop
-- or Xero. Long enough to catch "wrong item, spotted immediately"; short enough
-- that stock counts stay honest.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES (
  'shop_push_hold_seconds',
  '120',
  'Shop — seconds before a sale pushes to HireHop',
  'shop',
  'text',
  40
)
ON CONFLICT (key) DO NOTHING;
