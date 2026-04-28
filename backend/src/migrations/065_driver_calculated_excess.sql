-- Migration 065: driver-level calculated excess
--
-- Separates the per-DRIVER liability from the per-JOB excess record. Before
-- this, a driver's excess was only visible if they had a current
-- vehicle_hire_assignments row + linked job_excess record — so approved
-- drivers without a current job (or whose hire form chain didn't complete
-- through to POST /api/hire-forms) showed "—" on /drivers and had no edit
-- affordance.
--
-- New model:
--   drivers.calculated_excess_amount    — the driver's individual liability
--                                         (£1,200 floor; higher with referral).
--                                         Set at hire form completion. Always
--                                         shown on /drivers. Editable.
--   drivers.calculated_excess_basis     — free-text reason / source.
--   drivers.excess_locked               — if true, hire form re-submissions
--                                         won't auto-overwrite (manual override
--                                         protection).
--
-- Per-job excess records (job_excess) continue to carry payment state, claims,
-- reimbursements, top-N "Covered" status, etc. The driver liability is the
-- INPUT into the per-job calculation; the job_excess record is the
-- realisation of that liability for one specific hire.
--
-- See CLAUDE.md → "Step 2 / Driver Hire Forms" → "Driver-level liability
-- model" for the full pattern.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS calculated_excess_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS calculated_excess_basis  TEXT,
  ADD COLUMN IF NOT EXISTS excess_locked            BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN drivers.calculated_excess_amount IS
  'Driver''s individual excess liability. £1,200 floor for clean licence; higher with referral. Source of truth for the /drivers display and the input to per-job excess calculation.';

COMMENT ON COLUMN drivers.calculated_excess_basis IS
  'Free-text reason / source for the calculated amount (e.g. "Standard £1,200 floor", "Referral: 6+ pts").';

COMMENT ON COLUMN drivers.excess_locked IS
  'If true, hire form re-submissions and auto-recalculation will NOT overwrite calculated_excess_amount. Use for manual insurer-imposed overrides.';
