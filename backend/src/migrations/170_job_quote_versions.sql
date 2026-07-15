-- ============================================================================
-- 170: Auto-Chase — quote-PDF version diff (spec §7.3)
-- ============================================================================
-- The strongest dispute artefact isn't the email prose, it's the SUCCESSION of
-- quote PDFs we emailed. HireHop keeps only the latest state of a job, so the
-- versioned quote PDFs (named "Quote (NNNNN)" where NNNNN = HH job number) are
-- the real physical trail of "what was on the job when". We harvest them from
-- the mailbox (sent + received — quotes go out in OUR sent mail, which the live
-- ingestion filter skips, so this is a SEARCH-based harvest, not a piggyback),
-- store them here, vision-extract the line items, and diff consecutive versions.
--
-- Version ordering is by the message's FULL timestamp (received_at) — several
-- quotes can go back and forth in one day, and the (1)/(2) filename suffix is
-- download-order noise, NOT a version number.
--
-- Quote PDFs live ONLY here + a private R2 prefix (email-quotes/<jobId>/…) and
-- surface on the Activity Timeline. They deliberately NEVER enter jobs.files —
-- keeps the Files tab clean of signatures/logos AND of quote clutter (jon's
-- call). The general rider/stage-plot attachment harvest (§8.4) is a separate,
-- later feature with its own classification rules.
--
-- Two dedicated tables, off the hot jobs row (matching job_comms_summaries /
-- job_financials): the versions, plus a tiny per-job harvest cursor so opening
-- a job's timeline doesn't re-search Gmail every time (and so "never harvested"
-- is distinguishable from "harvested, no quotes found").
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_quote_versions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- The Gmail message the PDF was attached to (dedup at message level to avoid
  -- re-downloading; a message can carry quotes for several jobs so this is not
  -- unique on its own).
  source_gmail_message_id TEXT,
  -- Full timestamp of the message → the version-ordering key.
  received_at             TIMESTAMPTZ NOT NULL,
  r2_key                  TEXT NOT NULL,             -- email-quotes/<jobId>/<msgId>-<file>
  filename                TEXT,                      -- original attachment filename
  -- SHA-256 of the PDF bytes → the true "is this the same quote" key. The same
  -- PDF forwarded back / quoted in a reply chain dedups; different bytes on a
  -- later timestamp is a genuine new version.
  content_hash            TEXT NOT NULL,
  -- Extracted line items { items: [{description, qty, unit_price, discount, price}], quote_total }.
  -- NULL until lazily vision-extracted on first view (bounds token spend to jobs
  -- someone actually opens — the job_comms_summaries pattern).
  items                   JSONB,
  extracted_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per distinct quote PDF per job.
  UNIQUE (job_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_job_quote_versions_job_received
  ON job_quote_versions (job_id, received_at);

-- Per-job harvest cursor: "when did we last search the mailbox for this job's
-- quotes". Lets the GET serve cached versions without re-hitting Gmail on every
-- timeline open, and distinguishes "never searched" from "searched, none found".
CREATE TABLE IF NOT EXISTS job_quote_harvest_state (
  job_id           UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_harvested_at TIMESTAMPTZ,
  versions_found   INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
