/**
 * Portal Notification Preferences
 *
 * Single source of truth for "should I send this informational notification?"
 * Two notification classes for the freelancer/staff portal:
 *
 *   • Informational (mutable):
 *       - freelancer_assignment       (new D&C / crewed allocation)
 *       - job_change_notification     (date / time / venue change)
 *
 *   • Accountability (always sends):
 *       - completion-chaser ladder (2h / 6h / 14h)
 *
 * Informational senders MUST call shouldSuppressInformational() before sending
 * and skip the email if it returns suppress=true. Accountability senders MUST
 * NOT call this — chases bypass mute by design.
 *
 * Backed by people.portal_notifications_paused_until (TIMESTAMPTZ, future =
 * muted) and people.portal_muted_quote_ids (UUID[]). "Forever" is stored as
 * a far-future sentinel (year 2125) — anything > NOW() reads as muted.
 */
import { query } from '../config/database';

export interface SuppressionResult {
  suppress: boolean;
  reason?: string;
}

export async function shouldSuppressInformational(
  personId: string,
  quoteId?: string | null
): Promise<SuppressionResult> {
  const result = await query(
    `SELECT portal_notifications_paused_until, portal_muted_quote_ids
     FROM people
     WHERE id = $1`,
    [personId]
  );

  if (result.rows.length === 0) {
    return { suppress: false };
  }

  const row = result.rows[0];
  const pausedUntil: Date | null = row.portal_notifications_paused_until
    ? new Date(row.portal_notifications_paused_until)
    : null;

  if (pausedUntil && pausedUntil > new Date()) {
    const reason = `global mute until ${pausedUntil.toISOString()}`;
    console.log(`[notify] suppressed for person ${personId}: ${reason}`);
    return { suppress: true, reason };
  }

  const mutedIds: string[] = Array.isArray(row.portal_muted_quote_ids)
    ? row.portal_muted_quote_ids
    : [];
  if (quoteId && mutedIds.includes(quoteId)) {
    const reason = `per-job mute (quote ${quoteId})`;
    console.log(`[notify] suppressed for person ${personId}: ${reason}`);
    return { suppress: true, reason };
  }

  return { suppress: false };
}
