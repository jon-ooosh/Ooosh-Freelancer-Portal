-- House knowledge for Claude, Phase B (docs/AI-KNOWLEDGE-SPEC.md §4, Oct 2026).
--
-- A Staff Document can be shared with the Claude that drafts client emails.
-- ai_shared is set by an admin only (PUT /api/staff-documents/:id/ai). ai_topics
-- says which drafting tasks it applies to (voice, chasing, quoting_vans, ...) so
-- each draft reads only its own guides — services/house-knowledge.ts is the one
-- reader. Only the CURRENT version of an APPROVED, ACTIVE document is ever read.
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS ai_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff_documents ADD COLUMN IF NOT EXISTS ai_topics TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_staff_documents_ai_shared ON staff_documents(ai_shared) WHERE ai_shared = TRUE;
