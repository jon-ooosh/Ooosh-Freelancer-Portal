-- Migration 152: "Held on account" excess — a first-class parked state
-- ============================================================================
-- Some clients leave their excess with us on account for ages, booking vans as
-- and when. The old "Roll Over to Next Hire" button flipped the record to
-- excess_status='rolled_over' immediately — but with no destination job, that
-- status BURIED the money: v_excess_held (and every "held" aggregate) excludes
-- rolled_over on the assumption the cash moved to a forward child record. When
-- there's no child, the cash is still here, and it vanished from Total Held /
-- the ledger while physically sitting on the job in HireHop (job 16099 incident,
-- Jun 2026 — client's £1,200 "lost" until hand-fixed).
--
-- Fix: "held on account" is an ATTRIBUTE, not a status. The record stays
-- 'taken' (so it's already counted in v_excess_held, visible, clickable, and
-- fully actionable — reimburse when they want it back, or roll onto a real hire
-- when one is booked). This boolean just marks intent ("parked deliberately")
-- so we can badge it + stop it being chased for reimbursement. 'rolled_over' is
-- now reserved for money ACTUALLY applied to a child job (set by the
-- apply-forward flow only).

ALTER TABLE job_excess ADD COLUMN IF NOT EXISTS held_on_account BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: existing parked rollovers — records marked 'rolled_over' that were
-- NEVER chained forward (no other record shares their hh_deposit_id). Those are
-- the buried-cash cases. Flip them back to 'taken' + held_on_account=true so
-- they resurface as held and badged. Records WITH a forward child (genuinely
-- moved) are left as 'rolled_over' — the cash lives on the child.
UPDATE job_excess je
SET excess_status = 'taken',
    held_on_account = TRUE,
    notes = TRIM(BOTH FROM (COALESCE(je.notes, '') ||
      E'\n[Migration 152: was parked as rolled_over with no destination — restored to taken + held_on_account so it shows as held.]'))
WHERE je.excess_status = 'rolled_over'
  AND je.hh_deposit_id IS NOT NULL
  AND COALESCE(je.excess_amount_taken, 0) > 0
  AND NOT EXISTS (
    SELECT 1 FROM job_excess child
    WHERE child.hh_deposit_id = je.hh_deposit_id
      AND child.id <> je.id
      AND child.created_at > je.created_at
  );

CREATE INDEX IF NOT EXISTS idx_job_excess_held_on_account
  ON job_excess(held_on_account) WHERE held_on_account = TRUE;
