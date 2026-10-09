-- ============================================================================
-- 160: Interaction source classification + note editing
-- ============================================================================
-- Two related timeline improvements:
--
-- 1. `source` — separates genuine human-authored timeline entries ('user')
--    from auto-generated audit/system summaries ('system'). Both were stored
--    as type='note' so nothing could tell them apart; this is what lets the
--    Job View timeline recede/collapse the automated chatter and offer a
--    "Conversation only" view. DEFAULT 'user' is deliberate: a system insert
--    that forgets to tag itself merely shows as (harmless) noise, whereas a
--    mis-tagged human note would be wrongly hidden. Every runtime system
--    insert site is tagged source='system' explicitly in code.
--
-- 2. `edited_at` / `edited_by` — support creator-only editing of a note with
--    an "edited" marker for audit. Previous text is intentionally NOT kept
--    (kept simple; corrections by others go via a reply/comment).
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS source     VARCHAR(10) NOT NULL DEFAULT 'user'
    CHECK (source IN ('user', 'system')),
  ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by  UUID REFERENCES users(id);

-- Index for the "Conversation only" filter (source-scoped timeline reads).
CREATE INDEX IF NOT EXISTS idx_interactions_source ON interactions (source);

-- ----------------------------------------------------------------------------
-- Backfill: classify existing history as 'system' where it is clearly an
-- auto-generated audit entry. Conservative on purpose — anything not matched
-- stays 'user', so no genuine staff note/call/email is ever wrongly receded.
-- (Going forward, the code tags system inserts at their source; this only
-- cleans up rows created before this migration.)
-- ----------------------------------------------------------------------------

-- Status transitions and freelancer completions are always system-generated.
UPDATE interactions SET source = 'system'
  WHERE type IN ('status_transition', 'completion') AND source <> 'system';

-- Notes authored by the system service user.
UPDATE interactions SET source = 'system'
  WHERE type = 'note'
    AND created_by = '00000000-0000-0000-0000-000000000000'
    AND source <> 'system';

-- Auto-sent emails logged with no author (e.g. money / confirmation emails).
UPDATE interactions SET source = 'system'
  WHERE type = 'email' AND created_by IS NULL AND source <> 'system';

-- Notes whose content is a recognisable auto-generated summary line.
UPDATE interactions SET source = 'system'
  WHERE type = 'note'
    AND source <> 'system'
    AND content ~ '^(Job details updated|Created HireHop job|New enquiry created|Status changed|Vehicle swapped|Booked out|Job dispatched|Carnet|Issue logged|📎|🗑|🔗|📧|🔁|🔀|🚚|📦|🎫|📋|⚠|📓|🔧|🔄|🚐|↩|↪|🛠|💷|🧾|🔒)';
