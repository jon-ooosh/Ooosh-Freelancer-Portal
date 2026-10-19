-- Migration 201: which KIND of unsigned-form nudge was sent
--
-- Migration 196 keyed the nudge dedup on the job number alone: one email per
-- (driver, hire), ever. That was right when there was one email to send, and
-- wrong the moment there were two.
--
-- The nudge now sends different copy depending on how far the driver actually
-- got (services/unsigned-hire-form-nudge.ts):
--   'incomplete'    — documents still outstanding, here is what is left
--   'ready_to_sign' — everything verified, the ONLY thing left is the signature
--
-- Keyed on job number alone, a driver nudged while incomplete who then finished
-- their documents but stopped at the signature screen would never be chased —
-- which is exactly the Cameron Williams-Hill / 16618 case the nudge was built
-- for. Keying on (job number, stage) gives each driver at most one of each kind
-- per hire: enough to close the gap, never enough to spam someone who is
-- genuinely struggling to find a document.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS unsigned_nudge_stage VARCHAR(20);

COMMENT ON COLUMN drivers.unsigned_nudge_stage IS
  'Which kind of unsigned-form nudge was last sent for unsigned_nudge_job_number: incomplete | ready_to_sign. One of each kind per (driver, hire).';
