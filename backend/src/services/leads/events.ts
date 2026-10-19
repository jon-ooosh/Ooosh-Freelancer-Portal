/**
 * A lead's activity log — who did what, when. Read by the per-lead timeline and
 * the "Last activity" column (`lead_events`, migration 277).
 *
 * Best-effort: logging never fails the action it records.
 *
 * Events: found · matched · match_confirmed · match_rejected · researched ·
 * research_failed · address_book · contact_added · contact_removed · outreach ·
 * enquiry · dismissed · restored · status
 */
import { query } from '../../config/database';

export async function logLeadEvent(
  leadId: string,
  event: string,
  opts: { detail?: string | null; userId?: string | null; runId?: string | null } = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO lead_events (lead_id, event, detail, user_id, run_id) VALUES ($1, $2, $3, $4, $5)`,
      [leadId, event, opts.detail ?? null, opts.userId ?? null, opts.runId ?? null],
    );
  } catch (err) {
    console.error('[leads/events] failed to log %s for %s:', event, leadId, err);
  }
}
