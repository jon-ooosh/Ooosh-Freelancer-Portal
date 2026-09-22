-- ============================================================================
-- 232: Staff Records Phase 2 — the document's own date
-- ============================================================================
-- See docs/STAFF-RECORDS-SPEC.md §3.2 and §8 Phase 2.
--
-- ┌─ THIS FILE WAS REWRITTEN AFTER IT FAILED ON PRODUCTION, 22 Sep 2026 ─────┐
-- │ It is normally FORBIDDEN to edit a migration (CLAUDE.md). The exception  │
-- │ applies here because it never applied ANYWHERE: its original second half │
-- │ aborted the transaction, so the whole file rolled back and `_migrations` │
-- │ never recorded it. A file that always fails is not "applied somewhere",  │
-- │ it is a permanent roadblock — the runner retries it and every later      │
-- │ migration stays stuck behind it. See spec §13.6 for the full story.      │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- WHAT WAS REMOVED, AND WHY YOU MUST NOT PUT IT BACK:
-- The original version also re-imposed a CHECK constraint on `audit_log.action`
-- limiting it to create/update/delete/read. That was wrong twice over:
--
--   1. Migration 032 DELIBERATELY DROPPED that constraint and widened the
--      column to VARCHAR(50), because the platform needs actions like
--      'resolve_referral', 'merge', 'mark_washed', 'override_document_gate',
--      'correct_mileage' and a dozen more. Re-imposing it would have broken
--      every one of them. Postgres refused the migration because those rows
--      already exist — the database caught what review did not.
--
--   2. It meant a schema change for the files feature shared a transaction
--      with an unrelated change to a core table, so one blocked the other.
--      `document_date` could not land because of an audit-table constraint.
--      Keep unrelated concerns in separate migrations.
--
-- NOTHING was needed for the NI reveal's audit trail: `action` has been
-- unconstrained free text since 032, so writing 'read' has always just worked.
-- ============================================================================

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
