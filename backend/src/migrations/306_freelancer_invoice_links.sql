-- Freelancer invoices linked to the freelancer and to the work they pay for
-- (docs/FREELANCER-PORTAL-SPEC.md §5, jon, Oct 2026). The groundwork for the
-- portal's Earnings tab: "Invoice 1 paid, invoice 2 approved" per freelancer.
--
-- A freelancer still emails their invoice (PDF) to whoever booked them; the
-- office uploads it in Costs as before and now also says WHOSE it is and WHICH
-- work it covers. Money moves exactly as before (approve → Xero bill → pay).

-- Whose invoice: the freelancer (a people row; freelancers are people, not
-- organisations). Set on cost_type 'freelancer_invoice' costs only.
ALTER TABLE costs ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_costs_person ON costs (person_id) WHERE person_id IS NOT NULL;

-- "Query": the office has a question about this invoice ("the £80 train looks
-- high"). Shown as Queried in Costs and, later, in the freelancer's portal.
-- Cleared by approving it or by removing the query. No email is sent: the
-- office contacts the freelancer itself (jon).
ALTER TABLE costs ADD COLUMN IF NOT EXISTS queried_at TIMESTAMPTZ;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS queried_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS query_note TEXT;

-- Which work an invoice covers. One row per piece of work, each exactly one of:
-- a delivery / collection / crew booking (quote_assignments), a studio-sitter
-- evening (studio_sitter_shift_assignments) or a yard day
-- (freelancer_day_bookings). `amount` is this invoice's share for that work
-- (what we pay, VAT included when the freelancer charges it).
--
-- Deliberately NOT cost_allocations: those split a cost across JOBS for the
-- Money tab (GET /costs/by-job) and stay as they are. Sitter evenings and yard
-- days have no job at all.
CREATE TABLE IF NOT EXISTS cost_work_items (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cost_id              UUID NOT NULL REFERENCES costs(id) ON DELETE CASCADE,
  quote_assignment_id  UUID REFERENCES quote_assignments(id) ON DELETE CASCADE,
  sitter_assignment_id UUID REFERENCES studio_sitter_shift_assignments(id) ON DELETE CASCADE,
  day_booking_id       UUID REFERENCES freelancer_day_bookings(id) ON DELETE CASCADE,
  amount               NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cost_work_items_one_kind
    CHECK (num_nonnulls(quote_assignment_id, sitter_assignment_id, day_booking_id) = 1)
);
CREATE INDEX IF NOT EXISTS idx_cost_work_items_cost ON cost_work_items (cost_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_work_items_qa ON cost_work_items (cost_id, quote_assignment_id) WHERE quote_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_work_items_sitter ON cost_work_items (cost_id, sitter_assignment_id) WHERE sitter_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_work_items_day ON cost_work_items (cost_id, day_booking_id) WHERE day_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_work_items_qa ON cost_work_items (quote_assignment_id) WHERE quote_assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_work_items_sitter ON cost_work_items (sitter_assignment_id) WHERE sitter_assignment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_work_items_day ON cost_work_items (day_booking_id) WHERE day_booking_id IS NOT NULL;

-- Booked vs invoiced: fees should match; expenses are estimates, so an invoice
-- is "about right" while it is no more than the booked fees + expense
-- estimates + the larger of these (jon: "fixed or %"). Amber past it, never
-- blocking.
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('freelancer_invoice_tolerance_gbp', '10',
   'Freelancer invoices: allowed over the expense estimate, in £ (the larger of this and the % wins)',
   'freelancers', 'text', 91),
  ('freelancer_invoice_tolerance_pct', '25',
   'Freelancer invoices: allowed over the expense estimate, as a % of it (the larger of this and the £ wins)',
   'freelancers', 'text', 92)
ON CONFLICT (key) DO NOTHING;
