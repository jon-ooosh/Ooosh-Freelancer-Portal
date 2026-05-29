/**
 * Client Storage reminders — runs daily from config/scheduler.ts.
 *
 * Three nudge types, all bell-notification + (escalation-driven) email:
 *   1. Billing due soon — manual-billing tenancies approaching next_bill_date
 *   2. Billing overdue  — past next_bill_date + grace, still not marked invoiced
 *   3. Rate review due  — next_rate_review_date reached
 *
 * Dedup is per-cycle: each tenancy stamps the due/review date it last fired for
 * (billing_reminder_sent_for / billing_overdue_sent_for / rate_review_sent_for),
 * so a reminder fires once per cycle and resets when the date rolls forward
 * (mark-invoiced / rate-change clear the stamps). See docs/STORAGE-CLIENTS-SPEC.md.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

interface ReminderResult {
  billingDue: number;
  billingOverdue: number;
  reviews: number;
  accessEvents: number;
}

async function adminIds(): Promise<string[]> {
  const res = await query(`SELECT id FROM users WHERE role IN ('admin','manager') AND is_active = true`);
  return res.rows.map((r: Record<string, unknown>) => r.id as string);
}

async function notify(
  userIds: string[],
  title: string,
  content: string,
  entityId: string,
  priority: 'normal' | 'high' = 'normal'
): Promise<void> {
  for (const userId of userIds) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'follow_up', $2, $3, 'storage_tenancies', $4, '/storage?tab=tenancies', $5)`,
      [userId, title, content, entityId, priority]
    );
  }
}

/**
 * Notify the chosen recipients about a storage access request. Respects the
 * event's delivery_method (notification / email / both) the same way the
 * close-out chase scanner does, and stamps notified_at so it fires once.
 * Recipients default to admins/managers when no notify_user_ids were chosen.
 */
export async function notifyAccessEvent(eventId: string, notOnAccessList = false): Promise<void> {
  const ev = await query(
    `SELECT e.*, r.name AS room_name, o.name AS org_name,
            COALESCE(e.attendee_name, p.first_name || ' ' || p.last_name) AS attendee
     FROM storage_access_events e
     LEFT JOIN storage_tenancies t ON t.id = e.tenancy_id
     LEFT JOIN storage_rooms r ON r.id = COALESCE(e.room_id, t.room_id)
     LEFT JOIN organisations o ON o.id = t.organisation_id
     LEFT JOIN people p ON p.id = e.attendee_person_id
     WHERE e.id = $1`,
    [eventId]
  );
  if (ev.rows.length === 0) return;
  const e = ev.rows[0];
  const recipients: string[] = (e.notify_user_ids && e.notify_user_ids.length > 0) ? e.notify_user_ids : await adminIds();
  if (recipients.length === 0) { await query(`UPDATE storage_access_events SET notified_at = NOW() WHERE id = $1`, [eventId]); return; }

  const roomName = e.room_name || 'a storage unit';
  const who = e.attendee || 'someone';
  const title = `Storage access: ${roomName}`;
  const content = `${who} — ${e.description || e.type}${e.method === 'courier' ? ' (courier)' : ''}${notOnAccessList ? ' ⚠️ not on the access list' : ''}`;
  const delivery = e.delivery_method || 'both';
  // notification-only → low priority (escalation scheduler skips email for low)
  const priority = delivery === 'notification' ? 'low' : 'normal';

  for (const userId of recipients) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, email_sent_at)
       VALUES ($1,'follow_up',$2,$3,'storage_access_events',$4,'/storage?tab=access',$5,$6)`,
      [userId, title, content, eventId, priority, delivery === 'email' ? new Date() : null]
    );
    // Email-only delivery: send immediately (no escalation path for low priority).
    if (delivery === 'email') {
      try {
        const u = await query(`SELECT u.email, p.first_name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`, [userId]);
        if (u.rows[0]?.email) {
          await emailService.sendRaw({
            to: u.rows[0].email,
            subject: title,
            html: `<p>Hi ${u.rows[0].first_name || ''},</p><p>${content}</p>
                   <p><a href="${getFrontendUrl()}/storage?tab=access">View in Storage</a></p>`,
          });
        }
      } catch (err) { console.warn('[storage] access-event email failed:', err); }
    }
  }
  await query(`UPDATE storage_access_events SET notified_at = NOW() WHERE id = $1`, [eventId]);
}

export async function runStorageReminders(): Promise<ReminderResult> {
  const result: ReminderResult = { billingDue: 0, billingOverdue: 0, reviews: 0, accessEvents: 0 };
  const admins = await adminIds();

  // ── 1 + 2. Billing (manual mode only) ──────────────────────────────────
  const billing = await query(`
    SELECT t.id, t.next_bill_date, t.bill_reminder_lead_days, t.bill_overdue_grace_days,
           t.bill_reminder_person_id, t.billing_reminder_sent_for, t.billing_overdue_sent_for,
           t.weekly_rate, r.name AS room_name, o.name AS org_name
    FROM storage_tenancies t
    JOIN storage_rooms r ON r.id = t.room_id
    LEFT JOIN organisations o ON o.id = t.organisation_id
    WHERE t.status IN ('active','notice')
      AND t.billing_mode = 'manual'
      AND t.next_bill_date IS NOT NULL
  `);

  for (const t of billing.rows) {
    const targets = t.bill_reminder_person_id ? [t.bill_reminder_person_id as string] : admins;
    if (targets.length === 0) continue;
    const client = t.org_name || 'storage client';
    const dueIso = new Date(t.next_bill_date).toISOString().slice(0, 10);

    const overdueRes = await query(
      `SELECT (CURRENT_DATE >= ($1::date + ($2 || ' days')::interval)) AS overdue,
              (CURRENT_DATE >= ($1::date - ($3 || ' days')::interval)) AS due_soon`,
      [dueIso, t.bill_overdue_grace_days, t.bill_reminder_lead_days]
    );
    const { overdue, due_soon } = overdueRes.rows[0];

    if (overdue) {
      const stamp = t.billing_overdue_sent_for ? new Date(t.billing_overdue_sent_for).toISOString().slice(0, 10) : null;
      if (stamp !== dueIso) {
        await notify(targets,
          `Storage invoice overdue — ${client}`,
          `Invoice for ${t.room_name} (${client}) was due ${dueIso} and hasn't been marked sent.`,
          t.id, 'high');
        await query(`UPDATE storage_tenancies SET billing_overdue_sent_for = $1 WHERE id = $2`, [dueIso, t.id]);
        result.billingOverdue++;
      }
    } else if (due_soon) {
      const stamp = t.billing_reminder_sent_for ? new Date(t.billing_reminder_sent_for).toISOString().slice(0, 10) : null;
      if (stamp !== dueIso) {
        await notify(targets,
          `Storage invoice due — ${client}`,
          `Invoice for ${t.room_name} (${client}) is due ${dueIso}. Mark it sent on the Storage tab once done.`,
          t.id);
        await query(`UPDATE storage_tenancies SET billing_reminder_sent_for = $1 WHERE id = $2`, [dueIso, t.id]);
        result.billingDue++;
      }
    }
  }

  // ── 3. Rate reviews ──────────────────────────────────────────────────────
  const reviews = await query(`
    SELECT t.id, t.next_rate_review_date, t.rate_review_sent_for, t.bill_reminder_person_id,
           t.weekly_rate, t.last_rate_change_date, r.name AS room_name, o.name AS org_name
    FROM storage_tenancies t
    JOIN storage_rooms r ON r.id = t.room_id
    LEFT JOIN organisations o ON o.id = t.organisation_id
    WHERE t.status IN ('active','notice')
      AND t.next_rate_review_date IS NOT NULL
      AND t.next_rate_review_date <= CURRENT_DATE
  `);

  for (const t of reviews.rows) {
    const reviewIso = new Date(t.next_rate_review_date).toISOString().slice(0, 10);
    const stamp = t.rate_review_sent_for ? new Date(t.rate_review_sent_for).toISOString().slice(0, 10) : null;
    if (stamp === reviewIso) continue;
    const targets = t.bill_reminder_person_id ? [t.bill_reminder_person_id as string] : admins;
    if (targets.length === 0) continue;
    const client = t.org_name || 'storage client';
    const lastChange = t.last_rate_change_date ? ` (last changed ${new Date(t.last_rate_change_date).toISOString().slice(0, 10)})` : '';
    await notify(targets,
      `Storage rate review due — ${client}`,
      `Time to review the rate for ${t.room_name} (${client}). Currently £${Number(t.weekly_rate).toFixed(2)}/week${lastChange}.`,
      t.id);
    await query(`UPDATE storage_tenancies SET rate_review_sent_for = $1 WHERE id = $2`, [reviewIso, t.id]);
    result.reviews++;
  }

  // ── 4. Future-dated access requests now due ──────────────────────────────
  const dueAccess = await query(
    `SELECT id FROM storage_access_events
     WHERE status IN ('requested','scheduled')
       AND requested_date IS NOT NULL AND requested_date <= CURRENT_DATE
       AND notified_at IS NULL`
  );
  for (const a of dueAccess.rows) {
    await notifyAccessEvent(a.id as string);
    result.accessEvents++;
  }

  return result;
}
