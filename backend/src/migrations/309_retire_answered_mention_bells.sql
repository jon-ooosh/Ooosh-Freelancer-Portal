-- Retire the mention bells their recipient has already answered (jon, Oct 2026).
--
-- From this release, replying in a thread or adding a reaction to something
-- in it marks the replier's / reactor's OWN mention bells on that thread read
-- and done (services/notification-resolve.ts resolveMyThreadMentions). Bells
-- answered BEFORE it are still lit; this clears those once, by the same rule:
--
--   * a REPLY by the bell's owner in the same thread, posted after the bell;
--   * a REACTION by the bell's owner to the message that mentioned them, or to
--     a later message in the thread. Reactions carry no timestamp, but one on
--     a message that is no older than the mention must have come after it.
--
-- Threads are flat (a reply's parent is always the root — routes/interactions.ts
-- flattens on write), so the thread's root is COALESCE(parent, id). Only type
-- 'mention' (the "X mentioned you" and "X replied in a thread" bells), and only
-- the owner's own answer counts. Re-running it changes nothing.

WITH bells AS (
  SELECT n.id,
         n.user_id,
         n.created_at,
         mi.created_at AS mention_at,
         COALESCE(mi.parent_interaction_id, mi.id) AS root_id
    FROM notifications n
    JOIN interactions mi ON mi.id = n.interaction_id
   WHERE n.type = 'mention'
     AND n.acknowledged_at IS NULL
),
answered AS (
  SELECT b.id
    FROM bells b
   WHERE EXISTS (
           SELECT 1
             FROM interactions r
            WHERE r.parent_interaction_id = b.root_id
              AND r.created_by = b.user_id
              AND r.created_at > b.created_at)
      OR EXISTS (
           SELECT 1
             FROM interactions x
            CROSS JOIN LATERAL jsonb_each(
                    CASE WHEN jsonb_typeof(x.reactions) = 'object'
                         THEN x.reactions ELSE '{}'::jsonb END) e
            WHERE (x.id = b.root_id OR x.parent_interaction_id = b.root_id)
              AND x.created_at >= b.mention_at
              AND jsonb_typeof(e.value) = 'array'
              AND e.value ? b.user_id::text)
)
UPDATE notifications n
   SET is_read = true,
       read_at = COALESCE(n.read_at, NOW()),
       acknowledged_at = NOW()
  FROM answered a
 WHERE n.id = a.id;
