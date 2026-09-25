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
 *   4. Escalate — pending assignment older than escalate_after_days →
 *                 bell the managers that staff X hasn't completed it. Laddered:
 *                 re-fires every escalate_after_days until done.
 *   5. Content review — document whose owner content-review is due → chase the
 *                 owners/author weekly to review it's still current (mark
 *                 reviewed / publish a new version), escalating to managers once
 *                 overdue by escalate_after_days (laddered).
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
const CONTENT_REVIEW_CHASE_DAYS = 7;

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
  contentReviewChased: number;
  contentReviewEscalated: number;
}

export async function runStaffDocumentReminders(): Promise<StaffDocReminderResult> {
  const result: StaffDocReminderResult = {
    lapsed: 0, renewalNudges: 0, chased: 0, escalated: 0,
    contentReviewChased: 0, contentReviewEscalated: 0,
  };

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

  // ── 4. Escalate stale pending to managers (laddered — re-escalates) ───────
  // First escalation once the assignment is older than escalate_after_days; then
  // re-escalates every escalate_after_days it stays outstanding, so a
  // chronically-unsigned document keeps surfacing rather than going quiet after
  // a single manager nudge.
  const stale = await query(
    `SELECT a.id, a.document_id, a.escalated_at, d.title, a.assigned_at,
            COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''), u.email) AS staff_name
       FROM staff_document_assignments a
       JOIN staff_documents d ON d.id = a.document_id
       JOIN users u ON u.id = a.user_id AND u.is_active = true
       LEFT JOIN people p ON p.id = u.person_id
      WHERE d.is_active AND d.completion_mode <> 'read_only'
        AND a.status = 'pending'
        AND d.escalate_after_days IS NOT NULL
        AND (
          (a.escalated_at IS NULL AND a.assigned_at < NOW() - (d.escalate_after_days || ' days')::interval)
          OR a.escalated_at < NOW() - (d.escalate_after_days || ' days')::interval
        )`,
  );
  if (stale.rows.length) {
    const mgrs = await query(
      `SELECT id FROM users WHERE is_active = true AND role IN ('admin', 'manager', 'weekend_manager')`,
    );
    for (const r of stale.rows) {
      // Optimistic guard on the value we read — a concurrent run can't double-fire.
      const stamp = await query(
        `UPDATE staff_document_assignments SET escalated_at = NOW()
          WHERE id = $1 AND escalated_at IS NOT DISTINCT FROM $2 RETURNING id`,
        [r.id, r.escalated_at],
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

  // ── 5. Content review — remind owners to review the document is still current.
  // Distinct from assignee renewal (phases 1-4): this renews the CONTENT, not a
  // person's acknowledgement. Chased weekly (to the owners / author) until they
  // mark it reviewed or publish a new version; escalated to managers, laddered,
  // once it is overdue by escalate_after_days (or 30 days by default).
  const reviewDue = await query(
    `SELECT d.id, d.title, d.created_by, d.owner_user_ids, d.escalate_after_days,
            d.content_review_due_date, d.content_review_chased_at, d.content_review_escalated_at
       FROM staff_documents d
      WHERE d.is_active = true AND d.approval_status = 'approved'
        AND d.content_review_interval_months IS NOT NULL
        AND d.content_review_due_date IS NOT NULL
        AND d.content_review_due_date <= CURRENT_DATE`,
  );
  const mgrsForReview = reviewDue.rows.length
    ? (await query(`SELECT id FROM users WHERE is_active = true AND role IN ('admin', 'manager', 'weekend_manager')`)).rows
    : [];
  for (const d of reviewDue.rows) {
    // Chase the owners (fallback: the author; fallback: managers) weekly.
    const needChase = !d.content_review_chased_at
      || new Date(d.content_review_chased_at).getTime() < Date.now() - CONTENT_REVIEW_CHASE_DAYS * 86_400_000;
    if (needChase) {
      const stamp = await query(
        `UPDATE staff_documents SET content_review_chased_at = NOW()
          WHERE id = $1 AND content_review_chased_at IS NOT DISTINCT FROM $2 RETURNING id`,
        [d.id, d.content_review_chased_at],
      );
      if (stamp.rows.length) {
        const ownerIds: string[] = Array.isArray(d.owner_user_ids) ? d.owner_user_ids : [];
        const recips = await query(
          `SELECT id FROM users WHERE is_active = true AND role <> 'freelancer'
             AND (id = ANY($1::uuid[]) OR id = $2)`,
          [ownerIds.length ? ownerIds : null, d.created_by],
        );
        const targets = recips.rows.length ? recips.rows : mgrsForReview;
        for (const t of targets) {
          await notifyUser(t.id, `Review due: ${d.title}`,
            `“${d.title}” is due for a content review — please check it's still accurate, then mark it reviewed (or publish a new version if it needs updating).`,
            d.id);
        }
        result.contentReviewChased += 1;
      }
    }
    // Escalate to managers once overdue by escalate_after_days (default 30), laddered.
    const overdueDays = d.escalate_after_days || 30;
    const overdueSince = new Date(d.content_review_due_date).getTime() < Date.now() - overdueDays * 86_400_000;
    const needEscalate = overdueSince && (!d.content_review_escalated_at
      || new Date(d.content_review_escalated_at).getTime() < Date.now() - overdueDays * 86_400_000);
    if (needEscalate) {
      const stamp = await query(
        `UPDATE staff_documents SET content_review_escalated_at = NOW()
          WHERE id = $1 AND content_review_escalated_at IS NOT DISTINCT FROM $2 RETURNING id`,
        [d.id, d.content_review_escalated_at],
      );
      if (stamp.rows.length) {
        const due = new Date(d.content_review_due_date).toLocaleDateString('en-GB');
        for (const m of mgrsForReview) {
          await notifyUser(m.id, `Overdue content review: ${d.title}`,
            `“${d.title}” has been due for a content review since ${due} and hasn't been reviewed.`,
            d.id, 'high');
        }
        result.contentReviewEscalated += 1;
      }
    }
  }

  return result;
}
