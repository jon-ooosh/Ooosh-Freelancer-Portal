-- Migration 077: Strip HireHop project prefix from existing job_name rows
--
-- HireHop's search_list.php and webhook payloads return JOB_NAME for sub-jobs
-- as "<Project> ► <JobName>". The 30-min sync and inbound webhook handlers
-- previously stored the prefixed form, which made OP renames revert on the
-- next read (the rename writeback pushed the leaf to HH, but the next inbound
-- pulled the prefixed form and clobbered).
--
-- Code fix: strip the prefix on inbound parse (services/hirehop-job-sync.ts +
-- routes/webhooks.ts). This migration cleans up the rows already polluted.
--
-- `►` (U+25B6) is HH's path separator and won't appear in genuine job names.
-- We split on " ► " (space-arrow-space) and keep only the segment after the
-- last separator, mirroring the runtime stripProjectPrefix() helper.

UPDATE jobs
SET    job_name  = regexp_replace(job_name, '^.* ► ', ''),
       updated_at = NOW()
WHERE  job_name LIKE '% ► %'
  AND  is_deleted = false;
