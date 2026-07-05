-- ============================================================================
-- 157: Auto-Chase Phase 1 — Gmail ingestion foundation
-- ============================================================================
-- Spec: docs/AUTO-CHASE-SPEC.md §5, §12.
--
-- Ingests the info@oooshtours.co.uk inbox (via Google Workspace domain-wide
-- delegation) and logs client emails onto job timelines as `interactions`,
-- which feeds the existing chase model for free (see CLAUDE.md "Pipeline
-- Chase Model").
--
-- Everything here is additive + nullable / defaulted so existing INSERTs keep
-- working unchanged. The whole feature is inert until GMAIL_* env vars are set
-- (config/gmail.ts guard) — this migration is safe to apply ahead of go-live.
-- ============================================================================

-- ── Email metadata on interactions ──────────────────────────────────────────
-- One ingested Gmail message = one interaction row (type='email'). `content`
-- holds the full body text; the columns below carry the routing/dedup metadata.
-- `gmail_message_id` is the dedup key (RFC822 Message-ID, globally unique) — a
-- partial UNIQUE index enforces one interaction per message even once §6 adds
-- manager mailboxes and the same email surfaces in several inboxes.
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS gmail_message_id TEXT,
  ADD COLUMN IF NOT EXISTS gmail_thread_id  TEXT,
  ADD COLUMN IF NOT EXISTS email_from       TEXT,
  ADD COLUMN IF NOT EXISTS email_to         TEXT,
  ADD COLUMN IF NOT EXISTS email_subject    TEXT,
  ADD COLUMN IF NOT EXISTS email_snippet    TEXT,
  ADD COLUMN IF NOT EXISTS email_direction  VARCHAR(10)
    CHECK (email_direction IS NULL OR email_direction IN ('inbound', 'outbound')),
  ADD COLUMN IF NOT EXISTS has_attachments  BOOLEAN NOT NULL DEFAULT false,
  -- Set by the retention sweep when the body is stripped (24-month window,
  -- see §5.6). NULL = body still present. Keeps metadata + summary; drops the
  -- verbatim PII payload for GDPR data-minimisation.
  ADD COLUMN IF NOT EXISTS body_stripped_at TIMESTAMPTZ;

-- Dedup key. Partial unique — only ingested emails carry a gmail_message_id,
-- every other interaction leaves it NULL and is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_interactions_gmail_message_id
  ON interactions (gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;

-- Thread lookup (dispute helper walks a thread; auto-chase latches onto it).
CREATE INDEX IF NOT EXISTS idx_interactions_gmail_thread
  ON interactions (gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

-- ── Gmail sync cursor (one row per delegated mailbox) ───────────────────────
-- history_id is the Gmail History API cursor for incremental fetch. NULL until
-- the first full backfill establishes a baseline.
CREATE TABLE IF NOT EXISTS gmail_sync_state (
  mailbox         TEXT PRIMARY KEY,             -- e.g. 'info@oooshtours.co.uk'
  history_id      TEXT,                         -- last-seen Gmail historyId
  last_synced_at  TIMESTAMPTZ,
  last_error      TEXT,                         -- last failure message (cleared on success)
  messages_seen   BIGINT NOT NULL DEFAULT 0,    -- lifetime counter (telemetry)
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Unmatched inbound review queue ──────────────────────────────────────────
-- Messages the matcher couldn't confidently attach to a job. Staff hand-link
-- from here; each link feeds the matcher over time. Never guess-attach.
CREATE TABLE IF NOT EXISTS gmail_unmatched_inbound (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox          TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id  TEXT,
  email_from       TEXT,
  email_to         TEXT,
  email_subject    TEXT,
  email_snippet    TEXT,
  has_attachments  BOOLEAN NOT NULL DEFAULT false,
  received_at      TIMESTAMPTZ,
  -- Resolution: staff picks a job (creates the interaction), or dismisses.
  resolved_job_id  UUID REFERENCES jobs(id) ON DELETE SET NULL,
  resolved_by      UUID REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  dismissed        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_unmatched_gmail_message UNIQUE (gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_unmatched_open
  ON gmail_unmatched_inbound (received_at DESC)
  WHERE resolved_job_id IS NULL AND dismissed = false;

-- ── Auto-chase state on jobs ────────────────────────────────────────────────
-- Per-quote graduation dial set on the ChaseModal (§9.4). Default 'off' for a
-- conservative first rollout. `auto_chase_count` powers cold-dead-end
-- escalation (§10) — after N silent chases, stop and ask a human.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS auto_chase_mode   VARCHAR(10) NOT NULL DEFAULT 'off'
    CHECK (auto_chase_mode IN ('off', 'draft', 'send')),
  ADD COLUMN IF NOT EXISTS auto_chase_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_auto_chase_at TIMESTAMPTZ;

-- ── System settings (tunable without a deploy) ──────────────────────────────
INSERT INTO system_settings (key, value, label, category, value_type, sort_order)
VALUES
  ('chase_voice_instructions', '',
   'Chase voice — extra tone guidance appended to the AI chase-draft prompt',
   'chase', 'text', 10),
  ('email_retention_months', '24',
   'Months to keep full ingested-email bodies before stripping (metadata + summary kept)',
   'chase', 'text', 20),
  ('auto_chase_max_silent', '3',
   'Silent chases before escalating a cold dead-end to a human',
   'chase', 'text', 30)
ON CONFLICT (key) DO NOTHING;
