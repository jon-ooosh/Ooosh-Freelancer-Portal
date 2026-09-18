-- 217_email_attribution_controls.sql
-- Auto-Chase filtering foundation (Sep 2026): make ingested-email attribution
-- honest + give humans two manual backstops, ahead of the manager-mailbox rollout.
--
--   * match_method / match_confidence  — persist WHY + HOW confidently an email
--     was attached to its job (the matcher already computes these, we just threw
--     them away). Drives the timeline provenance badge and thread-anchoring.
--   * hidden_at / hidden_by            — "hide from timeline" (confidentiality
--     backstop). A hidden email drops off the all-staff view + the AI reads
--     (summary / dispute helper) but STAYS visible to admin, audit preserved.
--   * reattached_* (detach / move)     — audit for the accuracy backstop: when
--     staff say "this isn't job A" the email's job_id is re-pointed (or nulled),
--     and we record where it came from + who moved it.
--
-- All nullable / additive — nothing here changes existing rows or reads until the
-- ingestion + route code starts writing them.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS match_method           TEXT,
  ADD COLUMN IF NOT EXISTS match_confidence       TEXT,
  ADD COLUMN IF NOT EXISTS hidden_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_by              UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reattached_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reattached_by          UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reattached_from_job_id UUID;

-- Fast "is this thread already anchored to a job?" lookup for thread-anchoring
-- (spec §5.3a). Only ingested emails carry gmail_thread_id, so this stays small.
CREATE INDEX IF NOT EXISTS idx_interactions_gmail_thread
  ON interactions (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;
