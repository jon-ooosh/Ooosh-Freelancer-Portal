-- 295: Retire account-auto-covered excess placeholders stranded beside a driver record
-- ============================================================================
-- For a client with auto-cover-from-account on (migration 174), the derivation
-- placeholder (assignment_id NULL, £1,200 per van) is waived by auto-cover as
-- soon as the job is confirmed. Both absorb lookups in routes/hire-forms.ts
-- skipped every 'waived' record, so the driver's hire form could not take the
-- placeholder over and inserted a SECOND £1,200 record, which auto-cover also
-- covered: two covered records on a one-van hire, "£2,400 required" on the
-- requirement card (job 16833, The Hoosiers, Oct 2026). The lookups now absorb
-- an auto-covered placeholder; this clears the ones already stranded (five on
-- production: 15322, 16156, 16687, 16745, 16833).
--
-- The placeholder becomes 'not_required' at £0 — the existing "on record,
-- nothing owed" state, which every lookup, top-N, auto-cover and its revert
-- already leave alone. Nothing is deleted. Without this, switching a client's
-- auto-cover off (or their held balance falling short) would revert BOTH
-- records to 'needed' and ask for £2,400 on a one-van hire.
--
-- Money-guarded: only a placeholder with no money and no money links is
-- touched, and only when the job has a driver-linked record carrying the charge.
UPDATE job_excess stub
SET excess_status = 'not_required',
    excess_amount_required = 0,
    notes = COALESCE(NULLIF(stub.notes, '') || E'\n', '') ||
      '[Migration 295: superseded by the driver''s own excess record — this placeholder was left behind when the hire form arrived (auto-cover absorb gap, job 16833). Nothing owed.]',
    updated_at = NOW()
WHERE stub.assignment_id IS NULL
  AND stub.excess_status = 'waived'
  AND COALESCE(stub.notes, '') LIKE '%[Auto-covered by account]%'
  AND COALESCE(stub.excess_amount_taken, 0) = 0
  AND COALESCE(stub.amount_held, 0) = 0
  AND stub.hh_deposit_id IS NULL
  AND stub.stripe_payment_intent_id IS NULL
  AND EXISTS (
    SELECT 1 FROM job_excess d
    WHERE d.job_id = stub.job_id
      AND d.assignment_id IS NOT NULL
      AND d.excess_status <> 'not_required'
  );
