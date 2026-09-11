-- ============================================================================
-- 163: Auto-Chase Phase 2 — per-job conversation summary cache
-- ============================================================================
-- Spec: docs/AUTO-CHASE-SPEC.md §7.1.
--
-- An AI digest (Haiku) of the ingested email thread(s) on a job, shown at the
-- top of the Activity Timeline. Complements the timeline email-collapse (which
-- HIDES detail) by surfacing the gist + "whose move is it next". Cheap +
-- cacheable, so cached here and regenerated only when new mail lands (staleness
-- is COMPUTED at read time by comparing the live email count / newest email
-- against the stored figures — nothing has to touch the ingest hot path).
--
-- Deliberately a dedicated table, off the hot `jobs` row, matching the
-- established "keep derived caches separate" pattern (job_financials,
-- job_balance_overrides, …). One row per job; regeneration UPSERTs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_comms_summaries (
  job_id         UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  headline       TEXT,                          -- one-line gist / current state
  summary        TEXT NOT NULL,                 -- 3-6 short sentences
  -- Staleness key: what the summary was generated FROM. If the job's live
  -- email-interaction count / newest timestamp move past these, the cache is
  -- stale and the next viewer regenerates it.
  email_count    INTEGER NOT NULL DEFAULT 0,
  last_email_at  TIMESTAMPTZ,
  model          TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by   UUID REFERENCES users(id)      -- NULL = system/auto-generated
);
