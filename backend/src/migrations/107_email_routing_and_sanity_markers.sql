-- 102 — Email routing per-job + dispatch/returned sanity-check markers
--
-- Three additions to `jobs`:
--
-- 1) `email_routing JSONB` — per-bucket recipient overrides. Sparse: empty
--    object = "every template goes to the primary job_contact (today's
--    behaviour)". When a bucket key is present, its value is an array of
--    person UUIDs that REPLACES the default recipient list for templates
--    mapped to that bucket. Buckets currently: bookings_payments,
--    send_invoice, hire_forms, excess, delivery_on_day. See
--    services/email-routing.ts for the canonical bucket list + the
--    template-to-bucket map.
--
-- 2) `under_dispatch_warned_at TIMESTAMPTZ` — sanity-check dedup marker.
--    Replaces the inline "fire on every book-out" warning in autoDispatchJob
--    with a deferred scanner: 15-min cron scans jobs that are
--    `pipeline_status='dispatched'` but `status<5` for >30 min, fires
--    ONCE per dispatch, stamps the marker. Cleared on transition out of
--    `dispatched` so the next dispatch is allowed to warn again.
--
-- 3) `returned_bookedout_warned_at TIMESTAMPTZ` — mirror marker for the
--    returned-side scanner. Same shape: scanner picks up jobs at
--    `pipeline_status='returned'` with still-booked-out assignments after
--    a grace window, fires once, stamps, clears on transition out of
--    `returned`.
--
-- All three default safely (`'{}'`/NULL) so existing rows are no-ops.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS email_routing JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS under_dispatch_warned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS returned_bookedout_warned_at TIMESTAMPTZ;

COMMENT ON COLUMN jobs.email_routing IS
  'Sparse JSONB of per-bucket person-UUID arrays — see services/email-routing.ts. Empty object = default to primary job_contact.';
COMMENT ON COLUMN jobs.under_dispatch_warned_at IS
  'Stamped by the dispatch sanity scanner after firing one warning email. Cleared on transition out of pipeline_status=dispatched.';
COMMENT ON COLUMN jobs.returned_bookedout_warned_at IS
  'Stamped by the returned sanity scanner after firing one warning email. Cleared on transition out of pipeline_status=returned.';
