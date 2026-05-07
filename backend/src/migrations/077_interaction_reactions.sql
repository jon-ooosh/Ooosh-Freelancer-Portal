-- ============================================================================
-- 077: Lightweight emoji reactions on interactions
-- ============================================================================
-- Tracks per-user emoji reactions on any interaction (note, mention, reply,
-- chase, etc.). Stored as JSONB on interactions itself rather than a
-- separate table — the cardinality is low (curated 6-emoji palette, only
-- staff users can react), the read pattern is "read with the interaction"
-- (no separate join needed), and the write pattern is a single UPDATE per
-- toggle. A separate reactions table would buy nothing here.
--
-- Shape: { "👍": ["uuid", "uuid"], "❤️": ["uuid"] }
--   - keys: emoji strings from a small whitelisted palette (enforced in
--     routes/interactions.ts)
--   - values: arrays of user UUIDs who have applied that reaction
--
-- A user can toggle the same emoji on/off (idempotent), and may apply
-- multiple different emojis to the same interaction.
--
-- No notifications fire on reactions — this is the lightweight "I saw it,
-- no further action needed" pattern. Matches the working agreement that
-- prompted this addition (jon, May 2026): "want to thumbs-up things that
-- don't really warrant anything else".
-- ============================================================================

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}'::jsonb;
