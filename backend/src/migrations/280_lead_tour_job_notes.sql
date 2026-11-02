-- Leads: the reverse link — a job linked to a Lead Finder tour gets a note on
-- its activity timeline ("Tour spotted by the Lead Finder"). TOUR-FINDER-SPEC §19.
-- job_noted_at = when that note was written; NULL = not yet (backfilled by the
-- next search / "Match & research existing"). Cleared on unlink so a re-link
-- notes again.
ALTER TABLE lead_tour_jobs ADD COLUMN IF NOT EXISTS job_noted_at TIMESTAMPTZ;
