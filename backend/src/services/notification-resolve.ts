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
 * Open browsers are told (`notifications_resolved`) so the bell's count drops
 * without a reload.
 *
 * Wired up so far: leave requests (`retireLeaveRequestBells()` in
 * staff-notifications.ts, called by approve / decline / withdraw in
 * staff-leave.ts). Mentions are next — INBOX-AND-WAREHOUSE.md.
 */
import { query } from '../config/database';
import { emitToUser } from '../config/socket';

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

    const idsByUser = new Map<string, string[]>();
    for (const row of rows) {
      idsByUser.set(row.user_id, [...(idsByUser.get(row.user_id) ?? []), row.id]);
    }
    for (const [userId, ids] of idsByUser) {
      emitToUser(userId, 'notifications_resolved', { ids });
    }
    return rows.length;
  } catch (e) {
    console.error(
      `[notification-resolve] ${opts.type} bells on ${opts.entityType} ${opts.entityId} failed (non-fatal):`, e);
    return 0;
  }
}
