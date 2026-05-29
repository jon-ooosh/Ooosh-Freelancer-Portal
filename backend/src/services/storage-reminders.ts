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

interface ReminderResult {
  billingDue: number;
  billingOverdue: number;
  reviews: number;
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

export async function runStorageReminders(): Promise<ReminderResult> {
  const result: ReminderResult = { billingDue: 0, billingOverdue: 0, reviews: 0 };
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

  return result;
}
