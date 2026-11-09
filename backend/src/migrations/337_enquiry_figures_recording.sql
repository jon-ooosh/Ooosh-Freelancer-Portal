-- 337: Recording what the business-figures view will need (docs/BUSINESS-FIGURES-SPEC.md, step 1).
-- Recording only — nothing reads these yet.
--
-- 1. The real time of every ingested email. interactions.created_at and
--    gmail_unmatched_inbound.received_at are when OP PULLED the message in (up to
--    ten minutes late live, the run date on a backfill); message_at is Gmail's own
--    internalDate — when it was actually sent or received. NULL on rows from before
--    this migration and on hand-logged emails.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS message_at TIMESTAMPTZ;
ALTER TABLE gmail_unmatched_inbound ADD COLUMN IF NOT EXISTS message_at TIMESTAMPTZ;

-- 2. Which way an unmatched email went. A client's first email AND our first reply
--    usually arrive before the enquiry exists, so both sit in the unmatched queue;
--    reply time needs to tell them apart. ('inbound' | 'outbound', NULL before now.)
ALTER TABLE gmail_unmatched_inbound ADD COLUMN IF NOT EXISTS email_direction VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_gmail_unmatched_message_at ON gmail_unmatched_inbound (message_at);

-- 3. Enquiries the 09:00 sweep closed because their start date passed with nobody
--    deciding. Its 'No Decision' is the same label staff pick by hand, so without this
--    a forgotten enquiry counts as a lost sale. lost_reason is unchanged.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_lost BOOLEAN NOT NULL DEFAULT false;

-- Past sweeps: each left a timeline note "Auto-marked as Lost — …". Only jobs still
-- lost with the sweep's own reason (a later manual reason means a person decided).
-- The sweep never stamped lost_at, so it takes the note's time.
UPDATE jobs j
   SET auto_lost = true,
       lost_at = COALESCE(j.lost_at, a.at)
  FROM (
    SELECT job_id, MAX(created_at) AS at
      FROM interactions
     WHERE type = 'status_transition' AND content LIKE 'Auto-marked as Lost%' AND job_id IS NOT NULL
     GROUP BY job_id
  ) a
 WHERE a.job_id = j.id
   AND j.pipeline_status = 'lost'
   AND COALESCE(j.lost_reason, '') IN ('No Decision', 'Confirmed Alternative Quote (from us)');
