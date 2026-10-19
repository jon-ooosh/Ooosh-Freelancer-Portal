-- ============================================================================
-- 271: Leads — client history, deeper matching, dismiss reasons, lead actions
-- ============================================================================
-- Spec: docs/TOUR-FINDER-SPEC.md §14.
--
--  * client_history       — snapshot of what OP knows about a matched act
--                           (enquiries / booked / lost + why / retros). Fed to
--                           the AI scorer so "quoted 10, lost 10" scores down.
--  * history_scored_at    — when the score last took that history into
--                           account. NULL on a matched lead = re-score it.
--  * match_via            — how the match was made: 'org_name' (band org by
--                           name), 'job_name' (booked under a management /
--                           agency org — jobs named after the band), 'created'
--                           (staff added the band from this lead).
--  * rejected_org_ids     — "None of these" / Reject on a possible match. The
--                           matcher never suggests these orgs again for the
--                           lead (they used to come straight back next run).
--  * known_contacts       — researched contacts whose email is already a
--                           person in the address book.
--  * status_note          — free text alongside status_reason (the dismiss
--                           reason code).
--  * lead_suppressions    — "Not a fit — don't show this band again". The
--                           detector skips a suppressed act before spending
--                           any Ticketmaster calls on it.
-- ============================================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_history    JSONB;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS history_scored_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS match_via         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS rejected_org_ids  UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS known_contacts    JSONB NOT NULL DEFAULT '[]';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status_note       TEXT;

-- Existing exact matches were all made on the org name.
UPDATE leads SET match_via = 'org_name'
 WHERE match_via IS NULL AND matched_organisation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_suppressions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_key   TEXT NOT NULL UNIQUE,          -- normaliseArtist(name)
  artist_name  TEXT NOT NULL,
  tm_artist_id TEXT,
  reason       TEXT NOT NULL DEFAULT 'not_a_fit',
  note         TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_suppressions_tm ON lead_suppressions (tm_artist_id) WHERE tm_artist_id IS NOT NULL;

-- Job-name matching ("Wedding Present – UK tour" booked under the management
-- company) searches jobs.job_name by band name. pg_trgm is enabled by 175.
CREATE INDEX IF NOT EXISTS idx_jobs_job_name_trgm ON jobs USING gin (job_name gin_trgm_ops);
