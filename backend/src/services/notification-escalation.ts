import { query } from '../config/database';
import emailService from './email-service';
import { frontendLink } from '../config/app-urls';

/**
 * Notification escalation service.
 * Checks for unread notifications past their escalation threshold
 * and sends email notifications based on priority and user preferences.
 *
 * Escalation timing:
 *   Low    → never escalate to email
 *   Normal → email after 4h (working hours)
 *   High   → email after 1h (working hours)
 *   Urgent → email immediately (bypass working hours)
 *
 * Working hours default: 08:00-18:00 Mon-Fri (until staff calendar built)
 */

// Escalation thresholds in minutes
const ESCALATION_THRESHOLDS: Record<string, number> = {
  low: -1,      // never
  normal: 240,  // 4 hours
  high: 60,     // 1 hour
  urgent: 0,    // immediate
};

function isWorkingHours(): boolean {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}

export async function runNotificationEscalation(): Promise<{
  checked: number;
  emailed: number;
  skipped: number;
}> {
  const stats = { checked: 0, emailed: 0, skipped: 0 };

  try {
    // Find unread notifications that haven't been emailed yet
    // Exclude: snoozed, already emailed, follow_ups not yet due, low priority
    // Names live on people, not users, so join via users.person_id.
    const result = await query(`
      SELECT n.id, n.user_id, n.type, n.title, n.content, n.priority,
             n.entity_type, n.entity_id, n.action_url, n.created_at,
             n.source_user_id,
             u.email AS recipient_email, rp.first_name AS recipient_name,
             sp.first_name AS sender_name, sp.last_name AS sender_last_name
      FROM notifications n
      JOIN users u ON u.id = n.user_id AND u.is_active = true
      JOIN people rp ON rp.id = u.person_id
      LEFT JOIN users su ON su.id = n.source_user_id
      LEFT JOIN people sp ON sp.id = su.person_id
      WHERE n.is_read = false
        AND n.email_sent_at IS NULL
        AND n.priority != 'low'
        AND (n.snoozed_until IS NULL OR n.snoozed_until <= NOW())
        AND (n.due_date IS NULL OR n.due_date <= NOW())
      ORDER BY n.created_at ASC
      LIMIT 50
    `);

    stats.checked = result.rows.length;

    if (stats.checked === 0) return stats;

    // Load user preferences in bulk
    const userIds = [...new Set(result.rows.map((r: Record<string, unknown>) => r.user_id))];
    const prefsResult = await query(
      `SELECT user_id, notification_type, delivery_method
       FROM user_notification_preferences
       WHERE user_id = ANY($1)`,
      [userIds]
    );

    const userPrefs: Record<string, Record<string, string>> = {};
    for (const row of prefsResult.rows) {
      if (!userPrefs[row.user_id as string]) userPrefs[row.user_id as string] = {};
      userPrefs[row.user_id as string][row.notification_type as string] = row.delivery_method as string;
    }

    const nowMs = Date.now();
    const currentlyWorkingHours = isWorkingHours();

    for (const notif of result.rows) {
      const priority = notif.priority as string;
      const thresholdMins = ESCALATION_THRESHOLDS[priority];

      // Low priority: never email
      if (thresholdMins < 0) {
        stats.skipped++;
        continue;
      }

      // Check user preference for this notification type
      const userId = notif.user_id as string;
      const notifType = notif.type as string;
      const deliveryPref = userPrefs[userId]?.[notifType] || 'both';

      // If user only wants in-app notifications, skip email
      if (deliveryPref === 'notification' || deliveryPref === 'none') {
        stats.skipped++;
        continue;
      }

      // Check if enough time has elapsed
      const createdAt = new Date(notif.created_at as string).getTime();
      const elapsedMins = (nowMs - createdAt) / 60000;

      if (elapsedMins < thresholdMins) {
        stats.skipped++;
        continue;
      }

      // Urgent bypasses working hours; everything else waits
      if (priority !== 'urgent' && !currentlyWorkingHours) {
        stats.skipped++;
        continue;
      }

      // Send escalation email
      try {
        const recipientEmail = notif.recipient_email as string;
        const recipientName = notif.recipient_name as string || 'there';
        const title = notif.title as string;
        const content = notif.content as string || '';
        const senderName = notif.sender_name
          ? `${notif.sender_name} ${notif.sender_last_name || ''}`.trim()
          : null;

        const priorityLabel = priority === 'urgent' ? 'URGENT: ' : priority === 'high' ? 'Important: ' : '';
        const actionUrl = notif.action_url as string | null;

        const subject = `${priorityLabel}${title}`;
        const actionLink = actionUrl
          ? `<p><a href="${frontendLink(actionUrl)}" style="color: #7B5EA7; text-decoration: underline;">View in Ooosh</a></p>`
          : '';
        const fromLine = senderName ? `<p style="color: #666; font-size: 13px;">From: ${senderName}</p>` : '';

        await emailService.sendRaw({
          to: recipientEmail,
          subject,
          html: `
            <p>Hi ${recipientName},</p>
            ${fromLine}
            <p style="font-size: 15px; margin: 16px 0;"><strong>${title}</strong></p>
            ${content ? `<p style="color: #333;">${content}</p>` : ''}
            ${actionLink}
            <p style="color: #999; font-size: 12px; margin-top: 24px;">
              You're receiving this because you have an unread notification on the Ooosh Operations Platform.
              You can adjust your notification preferences in your Inbox settings.
            </p>
          `,
          variant: 'internal',
        });

        // Mark as emailed
        await query(
          `UPDATE notifications SET email_sent_at = NOW() WHERE id = $1`,
          [notif.id]
        );

        stats.emailed++;
      } catch (emailErr) {
        console.error(`[Escalation] Failed to send email for notification ${notif.id}:`, emailErr);
        stats.skipped++;
      }
    }
  } catch (err) {
    console.error('[Escalation] Notification escalation failed:', err);
  }

  return stats;
}
