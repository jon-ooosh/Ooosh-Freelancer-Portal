-- ============================================================================
-- 358: The hire dates printed on each driver's hire agreement
-- ============================================================================
-- When a hire's dates change (most often extended while the van is out), the
-- driver's agreement still carries the old dates. Nothing recorded WHICH dates
-- an agreement was made with — only when it was made — so OP could not tell a
-- stale agreement from a current one when the driver row has no stored dates
-- of its own (they follow the job): HH 16892, Nov 2026, extended by two days
-- with no warning anywhere.
--
-- These columns hold the dates printed on the agreement PDF on file, written
-- every time one is made (book-out, Generate, the "Update hire forms" button).
-- services/hire-agreement-dates.ts compares them with the hire's current dates.
-- NULL = an agreement made before this migration: its dates are unknown, so
-- it is never flagged (we can't tell what it printed).
--
-- Own-van agreements live on vehicle_hire_assignments; a multi-van driver's
-- agreements for the OTHER vans live on hire_form_documents (mig 144).
-- ============================================================================

ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS agreement_hire_start DATE;
ALTER TABLE vehicle_hire_assignments ADD COLUMN IF NOT EXISTS agreement_hire_end DATE;

ALTER TABLE hire_form_documents ADD COLUMN IF NOT EXISTS agreement_hire_start DATE;
ALTER TABLE hire_form_documents ADD COLUMN IF NOT EXISTS agreement_hire_end DATE;
