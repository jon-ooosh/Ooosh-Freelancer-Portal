-- 334: Band watch — better matching and the back catalogue (TOUR-FINDER-SPEC §21.8).
--
-- From the first week live (5 Nov 2026): every watch Ticketmaster couldn't
-- match had found NOTHING at all — three bands filed under their company name
-- ("Skindred LLP"), the rest not bands (suppliers, a person). So:
--   * a new state, 'unknown' — Ticketmaster has never heard of the name. Not
--     on "Match these" (that's for a name with several possible acts); looked
--     up again every month in case the act appears. 'not_found' stays what a
--     PERSON says ("not on Ticketmaster") and is never looked up again.
--   * tm_looked_up_at — when the act was last looked up.
--   * the watches waiting on "Match these" are looked up again with the new
--     name rule (company endings dropped) at the next run.
--   * band_watch_candidates — the back catalogue's Ticketmaster look-ups,
--     one row per organisation, so the list isn't slow to open.

ALTER TABLE band_watches DROP CONSTRAINT IF EXISTS band_watches_tm_match_check;
ALTER TABLE band_watches ADD CONSTRAINT band_watches_tm_match_check
  CHECK (tm_match IN ('pending', 'auto', 'confirmed', 'needs_match', 'not_found', 'unknown'));

ALTER TABLE band_watches ADD COLUMN IF NOT EXISTS tm_looked_up_at TIMESTAMPTZ;

UPDATE band_watches SET tm_match = 'pending', tm_candidates = '[]', updated_at = NOW()
 WHERE tm_match = 'needs_match';

-- status: 'known' = exactly one act with the name (watching it needs nobody);
-- 'ambiguous' = several acts with the name, or only similar names; 'unknown' =
-- Ticketmaster has nothing. exact_count = acts with exactly the name.
CREATE TABLE IF NOT EXISTS band_watch_candidates (
  organisation_id    UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  tm_status          TEXT NOT NULL CHECK (tm_status IN ('known', 'ambiguous', 'unknown')),
  exact_count        INTEGER NOT NULL DEFAULT 0,
  tm_attraction_id   TEXT,
  tm_attraction_name TEXT,
  tm_upcoming        INTEGER,
  tm_candidates      JSONB NOT NULL DEFAULT '[]',
  looked_up_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
