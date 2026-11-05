-- 336: Cash forecast tidy-ups (docs/CASHFLOW-FORECAST-SPEC.md §13.4), Nov 2026.
--
-- 1. VAT "so far this quarter", typed on the Monday check-in from Xero's VAT return
--    (jon: standard VAT, quarters end Mar/Jun/Sep/Dec, paid by direct debit on the
--    10th of the second month after, or the next working day). One row per typing;
--    the latest per quarter is the figure. Negative is fine — a quarter with a big
--    purchase (six new vans) can leave HMRC owing us.
CREATE TABLE IF NOT EXISTS cashflow_vat_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quarter_end  DATE NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  as_of        DATE NOT NULL,
  entered_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cashflow_vat_snapshots_quarter ON cashflow_vat_snapshots(quarter_end, as_of DESC);

-- vat_quarter_end_month: 3 = quarters end Mar/Jun/Sep/Dec (1 = Jan/Apr/Jul/Oct, 2 = Feb/May/Aug/Nov).
-- vat_due_day: paid on this day of the second month after the quarter ends.
INSERT INTO cashflow_settings (key, value) VALUES
  ('vat_quarter_end_month', '3'),
  ('vat_due_day',           '10')
ON CONFLICT (key) DO NOTHING;

-- 2. "Dealt with outside OP" on Money › Overview › Overpaid invoices. An OP note
--    only — HireHop and Xero are not touched (recording a refund in HireHop to clear
--    one that was tidied in Xero would send it to Xero a second time). Kept with the
--    overpaid figure it was about: if HireHop's figure changes, the row comes back.
CREATE TABLE IF NOT EXISTS job_overpaid_dismissals (
  job_id        UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  notes         TEXT,
  dismissed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
