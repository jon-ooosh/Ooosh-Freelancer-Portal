-- ============================================================================
-- 277: Leads — activity log, batches, research tracking
-- ============================================================================
-- Spec: docs/TOUR-FINDER-SPEC.md §17.
--
--  * lead_events      — who did what to a lead, when (found, researched,
--                       outreach, enquiry, dismissed, restored, contact added…).
--                       Drives the per-lead timeline and "Contacted 7 Oct · Jon".
--  * first_run_id     — the search that FOUND the lead (last_run_id moves on
--                       every re-detection). Drives the batch filter.
--  * contacted_at     — when outreach was logged, for "contacted 14+ days ago,
--                       no enquiry".
--  * researched_at /
--    research_status  — 'found' | 'none' | 'failed'. A lead whose research
--                       found nothing is no longer retried every run (it used
--                       to eat the per-run cap); it's retried after a while, or
--                       on demand ("Research again").
--  * external_links   — the act's official site / socials from Ticketmaster
--                       and MusicBrainz, handed to the researcher.
--  * Research cap 20 → 40 (20 was a testing number — jon, Oct 2026). Only if
--    still at the old default; a value staff changed is left alone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  detail      TEXT,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  run_id      UUID REFERENCES lead_runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events (lead_id, created_at DESC);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_run_id    UUID REFERENCES lead_runs(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_at    TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS researched_at   TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS research_status TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_links  JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_leads_first_run ON leads (first_run_id);

-- Backfill: the run that last saw a lead is the best record of the one that found it.
UPDATE leads SET first_run_id = last_run_id WHERE first_run_id IS NULL;
UPDATE leads SET contacted_at = updated_at WHERE status = 'contacted' AND contacted_at IS NULL;
-- Leads that already have contacts were researched. Ones with none are left
-- NULL, so they get one more try with the improved research.
UPDATE leads SET research_status = 'found', researched_at = updated_at
 WHERE research_status IS NULL AND jsonb_typeof(contacts) = 'array' AND jsonb_array_length(contacts) > 0;

-- Backfill the timeline from what we already know (no "who" for these).
INSERT INTO lead_events (lead_id, event, detail, run_id, created_at)
SELECT l.id, 'found', NULL, l.first_run_id, l.created_at
  FROM leads l
 WHERE NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id);
INSERT INTO lead_events (lead_id, event, detail, created_at)
SELECT l.id, 'enquiry', COALESCE(j.job_name, 'Enquiry'), j.created_at
  FROM leads l JOIN jobs j ON j.id = l.converted_job_id
 WHERE NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.event = 'enquiry');
INSERT INTO lead_events (lead_id, event, detail, created_at)
SELECT l.id, 'outreach', l.status_note, l.contacted_at
  FROM leads l
 WHERE l.status = 'contacted'
   AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.event = 'outreach');
INSERT INTO lead_events (lead_id, event, detail, created_at)
SELECT l.id, 'dismissed', COALESCE(l.status_reason, '') || CASE WHEN l.status_note IS NOT NULL THEN ' — ' || l.status_note ELSE '' END, l.updated_at
  FROM leads l
 WHERE l.status = 'dismissed'
   AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.event = 'dismissed');

UPDATE system_settings SET value = '40'
 WHERE key = 'lead_contact_research_cap' AND value = '20';
