-- Chase dates belong to enquiries only (jon, Oct 2026).
--
-- A job's next_chase_date is meant to clear the moment it leaves the enquiry
-- stages (new_enquiry / quoting / paused / provisional). The pipeline status
-- route and the HireHop webhook did that; other paths did not — a deposit
-- confirming the job (record-payment.ts, the payment portal in money.ts), the
-- 09:00 stale-enquiry auto-lose, auto-dispatch, the confirmed → prepping and
-- → returned_incomplete moves. Those jobs kept their old chase date and, once
-- dispatched or completed, showed up as "overdue chases" on the dashboard and
-- the pipeline header while the pipeline list (enquiries only) showed none.
-- On 22 Oct 2026: 29 of the 33 "chases due" were dispatched or completed jobs.
--
-- One rule here, so every path that moves a job on obeys it, including any
-- added later. Only a CHANGE of status into a non-enquiry stage clears the
-- date; moving between enquiry stages (e.g. paused with a revisit date) never
-- does. The explicit clears in routes/pipeline.ts and routes/webhooks.ts stay
-- as they are.

CREATE OR REPLACE FUNCTION clear_chase_outside_enquiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pipeline_status IS DISTINCT FROM OLD.pipeline_status
     AND NEW.pipeline_status NOT IN ('new_enquiry', 'quoting', 'paused', 'provisional') THEN
    NEW.next_chase_date = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clear_chase_outside_enquiry ON jobs;
CREATE TRIGGER trg_clear_chase_outside_enquiry
  BEFORE UPDATE OF pipeline_status ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION clear_chase_outside_enquiry();

-- The stale dates already there (on 22 Oct 2026: 43 confirmed, 9 dispatched,
-- 21 completed, 51 lost). updated_at is deliberately left alone — nothing
-- about these jobs changed that anyone needs to see.
UPDATE jobs
   SET next_chase_date = NULL
 WHERE next_chase_date IS NOT NULL
   AND pipeline_status NOT IN ('new_enquiry', 'quoting', 'paused', 'provisional');
