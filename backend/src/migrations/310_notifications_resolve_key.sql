-- What a bell ASKS for, so it can retire itself when that is done (jon, Oct 2026).
--
-- Several bells share a type and a record with bells that must survive — a
-- Problem's "New issue" (asks somebody to deal with it) and its "Issue
-- resolved" (FYI) are both type 'system' on the same job_issues row. `type`
-- cannot be split to tell them apart: it drives the Inbox tabs and the
-- delivery preferences. So a bell that asks for something carries a key;
-- an FYI bell carries none (NULL) and is never retired automatically.
--
-- services/bell-rules.ts holds THE rule for each key ("still needed while
-- …"); services/notification-resolve.ts applies it — on a 5-minute sweep and
-- straight away from the code that finishes the thing.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resolve_key VARCHAR(60);

-- The sweep only ever looks at open, keyed bells.
CREATE INDEX IF NOT EXISTS idx_notifications_resolve_key
  ON notifications (resolve_key, entity_id)
  WHERE resolve_key IS NOT NULL AND acknowledged_at IS NULL;
