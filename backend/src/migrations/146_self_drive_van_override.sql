-- 146_self_drive_van_override.sql
--
-- Manual override for the auto-detected simultaneous self-drive van count.
--
-- HireHop's line-item quantity is the source for how many self-drive vans a
-- job has. But a "sequential swap" hire (one van replaced by another partway
-- through, controlled via per-item going-out dates in HH's supplying list)
-- lists qty-2 while only ONE van is out at any moment. The auto-derivation
-- then computes 2x excess (£2,400 not £1,200) and a 2-van requirement chain.
--
-- This column lets staff declare the real simultaneous count. The derivation
-- reads it as an INPUT (like is_van_and_driver / vehicle_slot_modes) — it is
-- NOT part of the recomputed hh_derived_flags output, so it survives every
-- sync. When set, it caps flags.self_drive_count, which drives the excess
-- amount, the hire-form top-N charge, and the additional-driver charge.
--
-- vehicle_structure_note is an optional free-text audit reason for the override.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS self_drive_van_override INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS vehicle_structure_note TEXT;
