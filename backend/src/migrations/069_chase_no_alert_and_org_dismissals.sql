-- Migration 069: 'No alert' chase delivery + dismissible org suggestions
--
-- Three small changes bundled together:
--
-- 1. Extend `jobs.chase_alert_delivery` CHECK to allow 'none'. Lets staff
--    set "move to Chasing pile when due, but don't ping anyone" — useful
--    for low-priority leads where the queue itself is the reminder.
--
-- 2. Add `organisations.dismissed_suggestions TEXT[]` so the smart
--    suggestion banners ("could this be a band?", "looks like a management
--    company") can be dismissed permanently per-org. Stable suggestion
--    keys: 'band-rename', 'band-rename-by-jobs', 'management-rename'.
--
-- 3. Backfill: existing new_enquiry / quoting jobs without a
--    next_chase_date get a default of CURRENT_DATE + 5 days, matching the
--    default applied by the New Enquiry form. Closes the gap where the
--    Pipeline list view's "Action Required" section was inflated by
--    historical enquiries that pre-date the 5-day default.

-- 1. Relax chase_alert_delivery CHECK to include 'none'
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_chase_alert_delivery_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_chase_alert_delivery_check
  CHECK (chase_alert_delivery IS NULL OR chase_alert_delivery IN ('bell', 'bell_email', 'none'));

-- 2. Dismissible suggestions on organisations
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS dismissed_suggestions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 3. Backfill missing chase dates on active pre-confirmed enquiries
UPDATE jobs
   SET next_chase_date = (CURRENT_DATE + INTERVAL '5 days')::date,
       updated_at = NOW()
 WHERE next_chase_date IS NULL
   AND pipeline_status IN ('new_enquiry', 'quoting')
   AND COALESCE(is_deleted, false) = false;
