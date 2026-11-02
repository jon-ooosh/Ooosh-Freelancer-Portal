-- ============================================================================
-- 318: Per-job recharges on a split cost
--
-- A freelancer's invoice often covers several jobs, and each job can have its
-- own fuel or tolls the client should pay back. Until now a recharge lived on
-- the COST (costs.recharge_*), so it could only ever bill ONE job: the cost's
-- own. The split (cost_allocations) said how much of the invoice each job
-- carries, but nothing could recharge a share.
--
-- This puts the same recharge lifecycle on each split row, so every job's share
-- can be recharged to that job's HireHop job and tracked to "done" on its own:
--   cost_intent      — that share is part of a quote, or an extra. NULL = the
--                      cost's own answer.
--   recharge_*       — exactly the columns costs carries (migrations 092, 150),
--                      same meanings: mode none|full|partial, the net amount,
--                      pending → recharged_hh | recharged_external | absorbed.
--
-- THE RULE: a cost is recharged EITHER as a whole (costs.recharge_*) OR per job
-- (cost_allocations.recharge_*), never both. The API enforces it, so no recharge
-- can be counted twice. Every existing recharge is a whole-cost one and stays
-- exactly as it is, including the few on costs that were later split.
--
-- v_cost_recharges is THE list of recharges, one row per job it bills. Every
-- reader (Recharges tab, dashboard, the job's close-out card) reads it rather
-- than costs.recharge_* directly, or a per-job recharge would be invisible.
--
-- The old `recharge` boolean on cost_allocations (092) was never used for
-- anything (no screen ever sets it); it is left in place and superseded by
-- recharge_mode.
-- ============================================================================

ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS cost_intent VARCHAR(20)
  CHECK (cost_intent IS NULL OR cost_intent IN ('quote_actual', 'extra'));
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_mode VARCHAR(10) NOT NULL DEFAULT 'none'
  CHECK (recharge_mode IN ('none', 'full', 'partial'));
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_amount          NUMERIC(12,2);  -- net to bill (final, after markup, once resolved)
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_status          VARCHAR(20)
  CHECK (recharge_status IS NULL OR recharge_status IN ('pending', 'recharged_hh', 'recharged_external', 'absorbed'));
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_base_amount     NUMERIC(12,2);  -- net before markup
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_markup_type     VARCHAR(12);    -- greater_of | percent | fixed | none
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_markup_value    NUMERIC(12,2);
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_resolution_note TEXT;
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_resolved_by     UUID REFERENCES users(id);
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_resolved_at     TIMESTAMPTZ;
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharged_to_hh_at       TIMESTAMPTZ;
ALTER TABLE cost_allocations ADD COLUMN IF NOT EXISTS recharge_hh_item_id      VARCHAR(40);

COMMENT ON COLUMN cost_allocations.recharge IS
  'Not used for anything. Superseded by recharge_mode (migration 318).';
COMMENT ON COLUMN cost_allocations.recharge_status IS
  'Recharge resolution for this job''s share: pending | recharged_hh | recharged_external | absorbed. NULL when recharge_mode=none.';

CREATE INDEX IF NOT EXISTS idx_cost_allocations_recharge_pending
  ON cost_allocations (job_id)
  WHERE recharge_mode <> 'none' AND COALESCE(recharge_status, 'pending') = 'pending';

-- A share's net (ex VAT). A split row holds a GROSS share of the invoice, and a
-- recharge bills net, so the share is netted at the cost's own VAT ratio (a
-- no-VAT freelancer invoice nets to itself). One definition, used by the view
-- below and by the job's Money tab read, so the two can't disagree.
CREATE OR REPLACE FUNCTION cost_share_net(share NUMERIC, cost_gross NUMERIC, cost_net NUMERIC)
RETURNS NUMERIC LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE WHEN cost_gross IS NOT NULL AND cost_gross <> 0 AND cost_net IS NOT NULL
              THEN ROUND(share * cost_net / cost_gross, 2)
              ELSE share END
$$;

-- THE list of recharges. Arm A: a whole-cost recharge, on the cost's own job (as
-- it always was). Arm B: a per-job recharge on a split share, on that share's
-- job. share_gross / share_net are what that row is a recharge OF: the whole
-- cost, or the share.
CREATE OR REPLACE VIEW v_cost_recharges AS
SELECT
  c.id                       AS cost_id,
  NULL::uuid                 AS allocation_id,
  c.job_id,
  c.cost_intent,
  c.recharge_mode,
  c.recharge_amount,
  c.recharge_status,
  (COALESCE(c.recharge_status, 'pending') = 'pending') AS is_pending,
  c.recharge_base_amount,
  c.recharge_markup_type,
  c.recharge_markup_value,
  c.recharge_resolution_note,
  c.recharge_resolved_by,
  c.recharge_resolved_at,
  c.recharged_to_hh_at,
  c.recharge_hh_item_id,
  c.amount_gross             AS share_gross,
  c.amount_net               AS share_net
FROM costs c
WHERE c.recharge_mode <> 'none'
UNION ALL
SELECT
  a.cost_id,
  a.id                       AS allocation_id,
  a.job_id,
  COALESCE(a.cost_intent, c.cost_intent) AS cost_intent,
  a.recharge_mode,
  a.recharge_amount,
  a.recharge_status,
  (COALESCE(a.recharge_status, 'pending') = 'pending') AS is_pending,
  a.recharge_base_amount,
  a.recharge_markup_type,
  a.recharge_markup_value,
  a.recharge_resolution_note,
  a.recharge_resolved_by,
  a.recharge_resolved_at,
  a.recharged_to_hh_at,
  a.recharge_hh_item_id,
  a.amount                   AS share_gross,
  cost_share_net(a.amount, c.amount_gross, c.amount_net) AS share_net
FROM cost_allocations a
JOIN costs c ON c.id = a.cost_id
WHERE a.recharge_mode <> 'none';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ooosh_backup') THEN
    GRANT SELECT ON v_cost_recharges TO ooosh_backup;
  END IF;
END $$;
