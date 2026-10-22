/**
 * Retiring a bell once the thing it asked for has been done.
 *
 * A bell is a copy of a fact at the moment it happened — "Matt has requested
 * holiday". Until Oct 2026 nothing ever went back to it: approving the request
 * on the Staff page left every admin's copy lit until each of them clicked
 * it. Every bell already records what it is about (`entity_type` +
 * `entity_id`), so the code that finishes the thing calls this and the bells
 * go with it.
 *
 * Rules (jon, Oct 2026):
 *  - It clears the bell for EVERYONE who got one. Once somebody has dealt with
 *    it, nobody else is needed.
 *  - "Cleared" is read AND done (`acknowledged_at`): the blue dot goes, the
 *    bell stays in the dropdown greyed out, and the Inbox hides it like any
 *    other Done item ("Show done" brings it back).
 *  - Only bells of the given `type`. The person who asked gets their own bell
 *    about the SAME row ("Time off approved") — a blanket clear by row would
 *    swallow it before they saw it.
 *  - Never throws. The thing has already happened; a bell left lit is the
 *    failure we had before, not a reason to fail the approval.
 *
 * MENTIONS are the exception to "everyone": a mention asks one PERSON, so only
 * that person's answer clears it (`resolveMyThreadMentions`, below).
 *
 * Open browsers are told (`notifications_resolved`, `{ ids, done }`) so the
 * bell's count drops without a reload. `done` is false when the bells were
 * only marked READ (`markMentionsSeen`).
 *
 * Wired up so far: leave, overtime and WFH requests (`retire…Bells()` in
 * staff-notifications.ts, called by their services); mentions (replies and
 * reactions in routes/interactions.ts, the timeline via
 * POST /notifications/seen). The rest: INBOX-AND-WAREHOUSE.md.
 */
import { query } from '../config/database';
import { emitToUser } from '../config/socket';
import { BELL_RULES, type BellKey, type BellRule } from './bell-rules';

/** Tell each affected person's open browsers which of their bells changed. */
function tellOwners(rows: { id: string; user_id: string }[], done: boolean): void {
  const idsByUser = new Map<string, string[]>();
  for (const row of rows) {
    idsByUser.set(row.user_id, [...(idsByUser.get(row.user_id) ?? []), row.id]);
  }
  for (const [userId, ids] of idsByUser) {
    emitToUser(userId, 'notifications_resolved', { ids, done });
  }
}

export async function resolveActionBells(opts: {
  entityType: string;
  entityId: string;
  /** Only bells of this type — see the rules above. */
  type: string;
}): Promise<number> {
  try {
    const r = await query(
      `UPDATE notifications
          SET is_read = true,
              read_at = COALESCE(read_at, NOW()),
              acknowledged_at = NOW()
        WHERE entity_type = $1
          AND entity_id = $2
          AND type = $3
          AND acknowledged_at IS NULL
        RETURNING id, user_id`,
      [opts.entityType, opts.entityId, opts.type],
    );
    const rows = r.rows as { id: string; user_id: string }[];
    tellOwners(rows, true);
    return rows.length;
  } catch (e) {
    console.error(
      `[notification-resolve] ${opts.type} bells on ${opts.entityType} ${opts.entityId} failed (non-fatal):`, e);
    return 0;
  }
}

/**
 * Retire the keyed bells whose thing is done (bell-rules.ts holds the rule —
 * this only applies it). With an `entityId`, just that record's: the instant
 * call from the code that finished it. Without, every bell of the key: the
 * sweep. Read AND done, for everyone the rule says is finished with it.
 * Never throws.
 */
export async function retireDoneBells(key: BellKey, entityId?: string | null): Promise<number> {
  const rule: BellRule | undefined = BELL_RULES[key];
  if (!rule) return 0;
  try {
    const params: unknown[] = [key];
    let oneRecord = '';
    if (entityId) {
      params.push(entityId);
      oneRecord = 'AND n.entity_id = $2';
    }
    // A reminder sent again (latestOnly): an older copy of the same key,
    // record and person is retired as soon as a newer one exists.
    const superseded = rule.latestOnly
      ? `OR EXISTS (SELECT 1 FROM notifications newer
                     WHERE newer.resolve_key = n.resolve_key
                       AND newer.user_id = n.user_id
                       AND newer.entity_id IS NOT DISTINCT FROM n.entity_id
                       AND newer.created_at > n.created_at)`
      : '';
    const r = await query(
      `UPDATE notifications n
          SET is_read = true,
              read_at = COALESCE(n.read_at, NOW()),
              acknowledged_at = NOW()
        WHERE n.resolve_key = $1
          AND n.acknowledged_at IS NULL
          ${oneRecord}
          AND (NOT (${rule.stillWaiting}) ${superseded})
        RETURNING n.id, n.user_id`,
      params,
    );
    const rows = r.rows as { id: string; user_id: string }[];
    tellOwners(rows, true);
    return rows.length;
  } catch (e) {
    console.error(`[notification-resolve] retiring ${key} bells${entityId ? ` on ${entityId}` : ''} failed (non-fatal):`, e);
    return 0;
  }
}

/**
 * Every key's rule, every open bell — the 5-minute sweep (config/scheduler.ts),
 * also run just before the escalator so a finished thing is never emailed.
 * One broken rule logs and the rest still run.
 */
export async function sweepDoneBells(): Promise<number> {
  let retired = 0;
  for (const key of Object.keys(BELL_RULES) as BellKey[]) {
    retired += await retireDoneBells(key);
  }
  return retired;
}

/**
 * Somebody took part in a thread — replied in it, or reacted to something in
 * it — so THEIR mention bells on that thread are done (jon, Oct 2026). Only
 * theirs: everyone else in the thread still has their own to answer.
 *
 * `interactionId` is any message in the thread (the reply just posted, or the
 * one reacted to); the thread is its root plus every reply on the root — the
 * same walk GET /interactions/:id/thread makes. Both the "X mentioned you"
 * and the low-priority "X replied in a thread" bells are type `mention`.
 */
export async function resolveMyThreadMentions(userId: string, interactionId: string): Promise<number> {
  try {
    const r = await query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_interaction_id, 0 AS depth
           FROM interactions WHERE id = $2
         UNION ALL
         SELECT i.id, i.parent_interaction_id, c.depth + 1
           FROM interactions i
           JOIN chain c ON i.id = c.parent_interaction_id
          WHERE c.depth < 10
       ),
       root AS (SELECT id FROM chain WHERE parent_interaction_id IS NULL LIMIT 1)
       UPDATE notifications
          SET is_read = true,
              read_at = COALESCE(read_at, NOW()),
              acknowledged_at = NOW()
        WHERE user_id = $1
          AND type = 'mention'
          AND acknowledged_at IS NULL
          AND interaction_id IN (
                SELECT i.id FROM interactions i, root
                 WHERE i.id = root.id OR i.parent_interaction_id = root.id)
        RETURNING id, user_id`,
      [userId, interactionId],
    );
    const rows = r.rows as { id: string; user_id: string }[];
    tellOwners(rows, true);
    return rows.length;
  } catch (e) {
    console.error(`[notification-resolve] mentions in thread of ${interactionId} failed (non-fatal):`, e);
    return 0;
  }
}

/**
 * Somebody opened the timeline a mention sits on: their mention bells for
 * that record are READ — the dot goes — but not done. Seeing a question is
 * not answering it (jon, Oct 2026). A snoozed bell is left alone: the snooze
 * was an explicit "remind me later".
 */
export async function markMentionsSeen(userId: string, entityType: string, entityId: string): Promise<number> {
  try {
    const r = await query(
      `UPDATE notifications
          SET is_read = true, read_at = NOW()
        WHERE user_id = $1
          AND type = 'mention'
          AND entity_type = $2
          AND entity_id = $3
          AND is_read = false
          AND (snoozed_until IS NULL OR snoozed_until <= NOW())
        RETURNING id, user_id`,
      [userId, entityType, entityId],
    );
    const rows = r.rows as { id: string; user_id: string }[];
    tellOwners(rows, false);
    return rows.length;
  } catch (e) {
    console.error(`[notification-resolve] mentions seen on ${entityType} ${entityId} failed (non-fatal):`, e);
    return 0;
  }
}
