-- ============================================================================
-- 232: Staff Records Phase 2 — key data
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §3.2 and §8 Phase 2.
--
-- THE SHORT VERSION: almost nothing new is needed, because migration 206
-- already added the columns. What was missing was a way to WRITE them, a place
-- to SEE them, and — found while building this — a guard stopping them being
-- handed to the whole team.
--
-- Already on `people` from migration 206, and NOT re-added here:
--   ni_number_encrypted · rtw_checked_on · rtw_document_type
--   rtw_expires_on      · rtw_checked_by
--   emergency_contact_* (mig 001 + 206)
--
-- A second copy on staff_employment would be the same mistake as the licence
-- data in spec §1.1, which already exists twice. One home, surfaced twice.
--
-- NOTE ON THE NAME `rtw_`: on `people` it means RIGHT TO WORK (mig 206). On
-- `staff_absences` it means RETURN TO WORK (mig 214) — rtw_required, rtw_date,
-- rtw_chased_at, and the 08:50 chase job. Two unrelated meanings, one prefix.
-- Nothing is renamed here (both are live and referenced), but do not assume an
-- `rtw_` column means what you expect: check which table it is on.
-- ============================================================================

-- ── The document's own date ─────────────────────────────────────────────────
-- Spec §1.3's rule, applied to the file table: humans record the FROM date —
-- the day the document was issued, signed or checked — and the system derives
-- any expiry from it. Never ask a human for "valid until".
--
-- This is what carries "employment contract + signed date" (spec §3.2) without
-- a `contract_signed_on` column on staff_employment: the contract IS a file, so
-- its signed date belongs on the file. It also gives every other type the same
-- field for free, which is precisely what the review cycles in §4 (Phase 6)
-- need to read. One column, two jobs, no second copy.
ALTER TABLE staff_record_files ADD COLUMN IF NOT EXISTS document_date DATE;

COMMENT ON COLUMN staff_record_files.document_date IS
  'The FROM date — issued / signed / checked. An INPUT, never a derived expiry (spec §1.3). Phase 6 derives review due dates from this.';

-- ── Audit: allow recording a READ ───────────────────────────────────────────
-- Revealing somebody's NI number is the one operation here worth a trail, and
-- a trail of writes only would miss it entirely. The existing CHECK allowed
-- create/update/delete, so a read could not be recorded at all.
--
-- Additive and safe to re-run: the constraint is dropped IF EXISTS and rebuilt
-- with the extra value. 'read' fits the existing VARCHAR(10).
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('create', 'update', 'delete', 'read'));

COMMENT ON COLUMN audit_log.action IS
  'create | update | delete | read. ''read'' is for deliberate reveals of sensitive data (e.g. a staff NI number), not for ordinary page views.';
