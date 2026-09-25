/**
 * The two things a review sends to the person being reviewed.
 *
 * docs/STAFF-RECORDS-SPEC.md §5.2 and §5.5. Both are one-shot, stamped on the
 * review row — a second "you have a review" every time jon fixes a typo, or a
 * second write-up when a completed review is amended, would teach people to
 * ignore both.
 *
 * WHY THE INVITE CARRIES THE QUESTIONS: §5.2 trimmed scheduling to a bare
 * confirmation precisely because the value was never the scheduling — it is
 * that this message brings the prep questions with it. A "you have a review on
 * Thursday" with nothing attached is the version worth not building.
 */

import { query } from '../config/database';
import { emailService } from './email-service';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Tell somebody their review is booked, and hand them the questions.
 *
 * Bell, not email: it lands beside everything else they get from the platform,
 * and the Step-7 escalation scheduler turns it into an email if that is what
 * their own notification preferences say. Nothing hand-rolled.
 *
 * Silently does nothing when the person has no login — a real case here, and
 * not an error worth failing the booking over.
 */
export async function sendReviewInvite(reviewId: string): Promise<boolean> {
  const r = await query(
    `SELECT sr.id, sr.scheduled_for::text AS scheduled_for, sr.invited_at,
            u.id AS user_id
       FROM staff_reviews sr
       JOIN users u ON u.person_id = sr.person_id AND u.is_active = true
      WHERE sr.id = $1 AND sr.status IN ('proposed','confirmed')`,
    [reviewId]
  );
  const row = r.rows[0];
  if (!row || row.invited_at) return false;

  // Stamp first: a duplicate invite is worse than a missed one, and the
  // booking itself has already succeeded by this point.
  await query('UPDATE staff_reviews SET invited_at = NOW() WHERE id = $1', [reviewId]);

  const { notifyStaffReviewBooked } = await import('./staff-notifications');
  await notifyStaffReviewBooked(row.user_id, reviewId, row.scheduled_for);
  return true;
}

/**
 * The write-up, after the meeting: what was agreed, what each side is doing
 * about it, and — if one came out of it — the pay change.
 *
 * The pay figure arrives HERE rather than in the room (§5.1). If somebody
 * knows their salary is being set in that hour, every honest answer to "what
 * isn't going well" costs them money, so the development conversation never
 * happens. This email is what makes deciding afterwards feel like process
 * rather than evasion.
 */
export async function sendReviewFollowUp(reviewId: string): Promise<boolean> {
  const r = await query(
    `SELECT sr.id, sr.scheduled_for::text AS scheduled_for, sr.shared_summary,
            sr.outcome, sr.follow_up_sent_at,
            sr.next_review_due::text AS next_review_due,
            p.email, COALESCE(p.preferred_name, p.first_name) AS first_name,
            sh.annual_amount, sh.effective_from::text AS effective_from
       FROM staff_reviews sr
       JOIN people p ON p.id = sr.person_id
       LEFT JOIN staff_salary_history sh ON sh.id = sr.salary_history_id
      WHERE sr.id = $1 AND sr.status = 'completed'`,
    [reviewId]
  );
  const row = r.rows[0];
  if (!row || row.follow_up_sent_at) return false;
  if (!row.email) {
    console.warn('[staff-review-followup] no email for review', reviewId, '— nothing sent');
    return false;
  }

  const tasks = await query(
    `SELECT t.title, t.due_date::text AS due_date,
            NULLIF(TRIM(COALESCE(op.preferred_name, op.first_name, '') || ' ' ||
                        COALESCE(op.last_name, '')), '') AS owner_name
       FROM staff_tasks t
       JOIN people op ON op.id = t.person_id
      WHERE t.source_type = 'staff_review' AND t.source_id = $1 AND t.status = 'open'
      ORDER BY t.due_date NULLS LAST`,
    [reviewId]
  );

  const parts: string[] = [];
  parts.push(`<h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your review — ${esc(fmtDate(row.scheduled_for))}</h2>`);
  parts.push(`<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">Hi ${esc(row.first_name || 'there')},</p>`);
  parts.push(`<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">Thanks for sitting down with me. Here's what we agreed, so we both have the same note of it.</p>`);

  if (row.shared_summary?.trim()) {
    parts.push(`<div style="margin:0 0 20px;padding:14px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
      <p style="margin:0;font-size:15px;color:#1e293b;line-height:1.6;white-space:pre-wrap;">${esc(row.shared_summary.trim())}</p>
    </div>`);
  }

  if (tasks.rows.length) {
    const lis = tasks.rows.map((t: { title: string; due_date: string | null; owner_name: string | null }) =>
      `<li style="margin:0 0 6px;font-size:15px;color:#334155;line-height:1.6;">${esc(t.title)}` +
      `${t.owner_name ? ` — <strong>${esc(t.owner_name)}</strong>` : ''}` +
      `${t.due_date ? `, by ${esc(fmtDate(t.due_date))}` : ''}</li>`
    ).join('');
    parts.push(`<p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">What we said we'd do</p>
      <ul style="margin:0 0 20px;padding-left:20px;">${lis}</ul>`);
  }

  if (row.annual_amount != null) {
    parts.push(`<div style="margin:0 0 20px;padding:14px 16px;background-color:#ecfdf5;border-radius:8px;border:1px solid #a7f3d0;">
      <p style="margin:0 0 4px;font-size:13px;color:#065f46;">Salary</p>
      <p style="margin:0;font-size:16px;color:#065f46;font-weight:600;">
        &pound;${Number(row.annual_amount).toLocaleString('en-GB')} a year${row.effective_from ? `, from ${esc(fmtDate(row.effective_from))}` : ''}
      </p>
    </div>`);
  }

  if (row.next_review_due) {
    parts.push(`<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">Next one is due around ${esc(fmtDate(row.next_review_due))}.</p>`);
  }
  parts.push(`<p style="margin:0;font-size:14px;color:#64748b;line-height:1.6;">If any of that doesn't match how you remember it, tell me and I'll change it.</p>`);

  const sent = await emailService.send('staff_review_followup', {
    to: row.email,
    variables: { reviewDate: fmtDate(row.scheduled_for) },
    bodyHtmlOverride: parts.join('\n'),
  });

  if (!sent.success) {
    console.error('[staff-review-followup] send failed for review', reviewId, sent.error);
    return false;
  }
  await query('UPDATE staff_reviews SET follow_up_sent_at = NOW() WHERE id = $1', [reviewId]);
  return true;
}
