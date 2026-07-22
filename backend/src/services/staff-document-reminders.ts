/**
 * Staff Documents & Training — daily reminder scanner.
 *
 * One pass per day (wired into config/scheduler.ts). All soft nudges — never a
 * hard gate. Four phases, in order (lapse first so a just-lapsed renewal is
 * chaseable in the same run):
 *
 *   1. Lapse   — completed assignment past its review interval → 'lapsed'
 *                (+ reset dedup stamps) + notify the user their renewal is due.
 *   2. Renew   — completed assignment within RENEWAL_LEAD_DAYS of expiry →
 *                one "coming up for renewal" nudge (review_reminder_sent_at).
 *   3. Chase   — pending/lapsed assignment whose document has a chase interval,
 *                due since chase_sent_at (first chase one interval after
 *                assignment) → nudge the user.
 *   4. Escalate — pending assignment older than escalate_after_days, once →
 *                 bell the managers that staff X hasn't completed it.
 *
 * Delivery: we write bell notifications. The Step-7 escalation scheduler emails
 * them per the recipient's notification preferences + priority — so we don't
 * hand-roll email here. Stamp-first-then-notify (a rare missed nudge beats
 * daily spam if a write blips), mirroring the receipt-chaser / storage-reminder
 * convention. Only active, non-read-only documents and active users are touched.
 *
 * No migration — chase_sent_at / escalated_at / review_reminder_sent_at all
 * exist on staff_document_assignments (migration 178).
 *
 * See docs/STAFF-DOCUMENTS-SPEC.md §5.
 */
import { query } from '../config/database';

const RENEWAL_LEAD_DAYS = 14;

async function notifyUser(
  userId: string, title: string, content: string, documentId: string,
  priority: 'low' | 'normal' | 'high' = 'normal',
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
     VALUES ($1, 'follow_up', $2, $3, 'staff_documents', $4, '/staff/documents', $5)`,
    [userId, title, content, documentId, priority],
  ).catch((e) => console.error('[staff-doc-reminders] notify failed:', e));
}

export interface StaffDocReminderResult {
  lapsed: number;
  renewalNudges: number;
  chased: number;
  escalated: number;
}

export async function runStaffDocumentReminders(): Promise<StaffDocReminderResult> {
  const result: StaffDocReminderResult = { lapsed: 0, renewalNudges: 0, chased: 0, escalated: 0 };

  // ── 1. Lapse expired completions ──────────────────────────────────────────
  const lapsed = await query(
    `UPDATE staff_document_assignments a
        SET status = 'lapsed', chase_sent_at = NULL, escalated_at = NULL, review_reminder_sent_at = NULL
       FROM staff_documents d
      WHERE a.document_id = d.id AND d.is_active AND d.completion_mode <> 'read_only'
        AND a.status = 'completed' AND a.expires_at IS NOT NULL AND a.expires_at <= NOW()
      RETURNING a.user_id, a.document_id, d.title, d.completion_mode`,
  );
  for (const r of lapsed.rows) {
    result.lapsed += 1;
    const verb = r.completion_mode === 'sign' ? 're-sign' : 'review and re-acknowledge';
    await notifyUser(r.user_id, `Renewal due: ${r.title}`,
      `“${r.title}” is due for renewal — please ${verb} it in your Staff Documents.`, r.document_id);
  }

  // ── 2. Renewal nudge (approaching expiry) ─────────────────────────────────
  const renew = await query(
    `SELECT a.id, a.user_id, a.document_id, a.expires_at, d.title
       FROM staff_document_assignments a
       JOIN staff_documents d ON d.id = a.document_id
      WHERE d.is_active AND d.completion_mode <> 'read_only'
        AND a.status = 'completed' AND a.expires_at IS NOT NULL
        AND a.expires_at > NOW() AND a.expires_at <= NOW() + ($1 || ' days')::interval
        AND a.review_reminder_sent_at IS NULL`,
    [RENEWAL_LEAD_DAYS],
  );
  for (const r of renew.rows) {
    const stamp = await query(
      `UPDATE staff_document_assignments SET review_reminder_sent_at = NOW()
        WHERE id = $1 AND review_reminder_sent_at IS NULL RETURNING id`,
      [r.id],
    );
    if (!stamp.rows.length) continue; // raced
    result.renewalNudges += 1;
    const due = new Date(r.expires_at).toLocaleDateString('en-GB');
    await notifyUser(r.user_id, `Renewal coming up: ${r.title}`,
      `“${r.title}” is due for renewal by ${due}. Please review it in your Staff Documents.`, r.document_id);
  }

  // ── 3. Chase pending / lapsed ─────────────────────────────────────────────
  const chase = await query(
    `SELECT a.id, a.user_id, a.document_id, d.title, d.completion_mode
       FROM staff_document_assignments a
       JOIN staff_documents d ON d.id = a.document_id
       JOIN users u ON u.id = a.user_id AND u.is_active = true
      WHERE d.is_active AND d.completion_mode <> 'read_only'
        AND a.status IN ('pending', 'lapsed')
        AND d.chase_interval_days IS NOT NULL
        AND (
          (a.chase_sent_at IS NULL AND a.assigned_at < NOW() - (d.chase_interval_days || ' days')::interval)
          OR a.chase_sent_at < NOW() - (d.chase_interval_days || ' days')::interval
        )`,
  );
  for (const r of chase.rows) {
    const stamp = await query(
      `UPDATE staff_document_assignments SET chase_sent_at = NOW() WHERE id = $1 RETURNING id`,
      [r.id],
    );
    if (!stamp.rows.length) continue;
    result.chased += 1;
    const verb = r.completion_mode === 'sign' ? 'sign' : 'review and acknowledge';
    await notifyUser(r.user_id, `Reminder: ${r.title}`,
      `Please ${verb} “${r.title}” in your Staff Documents.`, r.document_id);
  }

  // ── 4. Escalate stale pending to managers ─────────────────────────────────
  const stale = await query(
    `SELECT a.id, a.document_id, d.title, a.assigned_at,
            COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''), u.email) AS staff_name
       FROM staff_document_assignments a
       JOIN staff_documents d ON d.id = a.document_id
       JOIN users u ON u.id = a.user_id AND u.is_active = true
       LEFT JOIN people p ON p.id = u.person_id
      WHERE d.is_active AND d.completion_mode <> 'read_only'
        AND a.status = 'pending'
        AND d.escalate_after_days IS NOT NULL
        AND a.assigned_at < NOW() - (d.escalate_after_days || ' days')::interval
        AND a.escalated_at IS NULL`,
  );
  if (stale.rows.length) {
    const mgrs = await query(
      `SELECT id FROM users WHERE is_active = true AND role IN ('admin', 'manager', 'weekend_manager')`,
    );
    for (const r of stale.rows) {
      const stamp = await query(
        `UPDATE staff_document_assignments SET escalated_at = NOW() WHERE id = $1 AND escalated_at IS NULL RETURNING id`,
        [r.id],
      );
      if (!stamp.rows.length) continue;
      result.escalated += 1;
      const days = Math.floor((Date.now() - new Date(r.assigned_at).getTime()) / 86_400_000);
      for (const m of mgrs.rows) {
        await notifyUser(m.id, `Outstanding staff document: ${r.title}`,
          `${r.staff_name} still hasn’t completed “${r.title}” (assigned ${days} day${days === 1 ? '' : 's'} ago).`,
          r.document_id, 'high');
      }
    }
  }

  return result;
}
