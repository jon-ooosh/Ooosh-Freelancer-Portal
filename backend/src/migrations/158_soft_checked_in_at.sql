-- 158_soft_checked_in_at.sql
--
-- Marks when a freelancer soft-checked-in (collected) a van, WITHOUT closing
-- the hire. A collection is not the warehouse's final check-in: the freelancer
-- records interim state (mileage / fuel / photos / interim PDF) and the van
-- goes 'Not Ready', but the assignment stays out (status unchanged) for the
-- warehouse to formally check in + adjudicate damage.
--
-- Distinct from checked_in_at (the real return). This is the two-stage model
-- from the van-swap soft-check-in primitive (docs/VAN-SWAP-AND-SOFT-CHECKIN-SPEC.md)
-- applied to the freelancer-led collection flow.

ALTER TABLE vehicle_hire_assignments
  ADD COLUMN IF NOT EXISTS soft_checked_in_at TIMESTAMPTZ;
