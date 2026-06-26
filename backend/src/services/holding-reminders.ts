/**
 * Holding reminders — runs daily from config/scheduler.ts.
 *
 * Two nudges, both to staff (never client-facing here):
 *   1. Lost-property chase digest — when items are due a chase, assemble a
 *      single "N chases ready to review" nudge that deep-links to the review
 *      queue. We do NOT auto-send the client chase email; a human approves the
 *      batch on the review page (spec §7B). Deduped to once per ~20h.
 *   2. Hold-until / review — delivery + temp-storage items whose hold_until is
 *      within 3 days, reminding staff the hold/review date is approaching.
 *      Per-cycle dedup via hold_until_reminder_sent_for (stamps the hold_until
 *      it fired for, so it re-fires if the date is moved forward).
 *
 * See docs/HOLDING-MODULE-SPEC.md §7.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

const HOLD_UNTIL_LEAD_DAYS = 3;

interface HoldingReminderResult { chaseDigest: number; holdUntil: number; }

async function adminIds(): Promise<string[]> {
  const res = await query(`SELECT id FROM users WHERE role IN ('admin','manager') AND is_active = true`);
  return res.rows.map((r: Record<string, unknown>) => r.id as string);
}

async function notify(
  userIds: string[], title: string, content: string, entityId: string,
  actionUrl: string, priority: 'low' | 'normal' | 'high' = 'normal'
): Promise<void> {
  for (const userId of userIds) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'follow_up', $2, $3, 'held_items', $4, $5, $6)`,
      [userId, title, content, entityId, actionUrl, priority]
    );
  }
}

export async function runHoldingReminders(): Promise<HoldingReminderResult> {
  const result: HoldingReminderResult = { chaseDigest: 0, holdUntil: 0 };
  const admins = await adminIds();

  // ── 1. Lost-property chase digest ─────────────────────────────────────────
  // Same criteria as GET /holding/chases/review.
  const due = await query(
    `SELECT COUNT(*)::int AS n FROM held_items h
     WHERE h.kind = 'lost_property'
       AND h.status NOT IN ('collected','shipped_back','disposed','cancelled')
       AND (h.owner_person_id IS NOT NULL OR h.owner_organisation_id IS NOT NULL)
       AND (h.last_chased_at IS NULL OR h.last_chased_at < NOW() - INTERVAL '7 days')
       AND h.found_date IS NOT NULL AND h.found_date <= CURRENT_DATE - INTERVAL '7 days'
       AND (h.expected_collection_date IS NULL OR h.expected_collection_date < CURRENT_DATE)`
  );
  const dueCount = due.rows[0]?.n || 0;
  if (dueCount > 0) {
    // Dedup: skip if we already sent a chase digest in the last ~20h.
    const recent = await query(
      `SELECT 1 FROM notifications
       WHERE entity_type = 'held_items' AND title LIKE 'Lost property: %chase%'
         AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`
    );
    if (recent.rows.length === 0) {
      const reviewUrl = '/holding/lost-property?review=1';
      const title = `Lost property: ${dueCount} chase${dueCount === 1 ? '' : 's'} ready to review`;
      const content = `${dueCount} item${dueCount === 1 ? '' : 's'} due a chase. Review and send (or snooze) on the chase queue.`;
      await notify(admins, title, content, '00000000-0000-0000-0000-000000000000', reviewUrl, 'normal');
      try {
        await emailService.sendRaw({
          to: 'info@oooshtours.co.uk',
          subject: title,
          html: `<p>${content}</p><p><a href="${getFrontendUrl()}${reviewUrl}">Open the chase review queue →</a></p>
                 <p style="color:#64748b;font-size:13px;">Nothing is sent to clients automatically — each chase is sent by a person from that page.</p>`,
        });
      } catch (err) { console.warn('[holding-reminders] chase digest email failed:', err); }
      result.chaseDigest = dueCount;
    }
  }

  // ── 2. Hold-until / review reminders ──────────────────────────────────────
  // Delivery + temp-storage items: a hold/review date lets staff park "deal
  // with this by X" on anything we're holding (the two kinds blur in practice).
  const holds = await query(
    `SELECT h.id, h.kind, h.description, h.hold_until, h.hh_job_number,
            (p.first_name || ' ' || p.last_name) AS person_name, o.name AS org_name, h.client_name_text
     FROM held_items h
     LEFT JOIN people p ON p.id = h.owner_person_id
     LEFT JOIN organisations o ON o.id = h.owner_organisation_id
     WHERE h.kind IN ('incoming','temp_storage')
       AND h.status NOT IN ('collected','given_to_client','shipped_back','disposed','cancelled')
       AND h.hold_until IS NOT NULL
       AND h.hold_until <= CURRENT_DATE + ($1 || ' days')::interval
       AND (h.hold_until_reminder_sent_for IS DISTINCT FROM h.hold_until)`,
    [HOLD_UNTIL_LEAD_DAYS]
  );
  for (const h of holds.rows) {
    const who = h.person_name || h.org_name || h.client_name_text || 'a client';
    const when = new Date(h.hold_until).toLocaleDateString('en-GB');
    const overdue = new Date(h.hold_until) < new Date();
    const title = `Hold/review ${overdue ? 'date passed' : 'date approaching'}: ${h.description || 'item'}`;
    const content = `${who} — hold until ${when}${overdue ? ' (passed)' : ''}. Decide: collect / return / extend.`;
    await notify(admins, title, content, h.id, `/holding?item=${h.id}`, overdue ? 'high' : 'normal');
    await query(`UPDATE held_items SET hold_until_reminder_sent_for = hold_until WHERE id = $1`, [h.id]);
    result.holdUntil += 1;
  }

  return result;
}
