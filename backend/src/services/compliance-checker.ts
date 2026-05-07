/**
 * Vehicle Compliance Checker — evaluates fleet compliance status and
 * creates notifications for overdue / soon-due items.
 *
 * Called daily by the scheduler at 08:00.
 * Dedup: won't create duplicate notifications within the dedup window
 * (7 days for 'soon', 1 day for 'overdue').
 */

import { query } from '../config/database';

interface ComplianceAlert {
  vehicleId: string;
  reg: string;
  item: string;       // 'MOT', 'Tax', 'Insurance', 'TFL'
  date: string;        // YYYY-MM-DD
  urgency: 'soon' | 'overdue';
  daysRemaining: number;
}

interface ComplianceSettings {
  mot_warning_days: number;
  mot_urgent_days: number;
  tax_warning_days: number;
  tax_urgent_days: number;
  insurance_warning_days: number;
  insurance_urgent_days: number;
  tfl_warning_days: number;
  tfl_urgent_days: number;
  notification_roles: string[];
}

async function getComplianceSettings(): Promise<ComplianceSettings> {
  const result = await query('SELECT key, value FROM vehicle_compliance_settings');
  const settings: Record<string, unknown> = {};
  for (const row of result.rows) {
    try {
      settings[row.key as string] = JSON.parse(row.value as string);
    } catch {
      settings[row.key as string] = row.value;
    }
  }

  return {
    mot_warning_days: Number(settings.mot_warning_days) || 30,
    mot_urgent_days: Number(settings.mot_urgent_days) || 7,
    tax_warning_days: Number(settings.tax_warning_days) || 30,
    tax_urgent_days: Number(settings.tax_urgent_days) || 7,
    insurance_warning_days: Number(settings.insurance_warning_days) || 30,
    insurance_urgent_days: Number(settings.insurance_urgent_days) || 7,
    tfl_warning_days: Number(settings.tfl_warning_days) || 30,
    tfl_urgent_days: Number(settings.tfl_urgent_days) || 7,
    notification_roles: Array.isArray(settings.notification_roles) ? settings.notification_roles : ['admin', 'manager'],
  };
}

/**
 * Run the compliance check — returns alerts and optionally creates notifications.
 */
export async function runComplianceCheck(createNotifications = true): Promise<{
  alerts: ComplianceAlert[];
  notificationsCreated: number;
}> {
  const settings = await getComplianceSettings();

  // Fetch all active vehicles with relevant date fields
  const vehicleResult = await query(
    `SELECT id, reg, mot_due, tax_due, insurance_due, tfl_due
     FROM fleet_vehicles
     WHERE is_active = true AND fleet_group != 'old_sold'`
  );

  const checks: { label: string; field: string; warningDays: number; urgentDays: number }[] = [
    { label: 'MOT', field: 'mot_due', warningDays: settings.mot_warning_days, urgentDays: settings.mot_urgent_days },
    { label: 'Tax', field: 'tax_due', warningDays: settings.tax_warning_days, urgentDays: settings.tax_urgent_days },
    { label: 'Insurance', field: 'insurance_due', warningDays: settings.insurance_warning_days, urgentDays: settings.insurance_urgent_days },
    { label: 'TFL', field: 'tfl_due', warningDays: settings.tfl_warning_days, urgentDays: settings.tfl_urgent_days },
  ];

  const alerts: ComplianceAlert[] = [];
  const now = new Date();

  for (const vehicle of vehicleResult.rows) {
    for (const check of checks) {
      const dateVal = vehicle[check.field];
      if (!dateVal) continue;

      const dueDate = new Date(dateVal as string);
      const diffMs = dueDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays < 0) {
        alerts.push({
          vehicleId: vehicle.id as string,
          reg: vehicle.reg as string,
          item: check.label,
          date: (dateVal as Date).toISOString().split('T')[0]!,
          urgency: 'overdue',
          daysRemaining: diffDays,
        });
      } else if (diffDays <= check.warningDays) {
        alerts.push({
          vehicleId: vehicle.id as string,
          reg: vehicle.reg as string,
          item: check.label,
          date: (dateVal as Date).toISOString().split('T')[0]!,
          urgency: diffDays <= check.urgentDays ? 'overdue' : 'soon',
          daysRemaining: diffDays,
        });
      }
    }
  }

  let notificationsCreated = 0;

  if (createNotifications && alerts.length > 0) {
    // Vehicle alerts go to info@ + will@ only — see services/vehicle-notify.ts.
    // The legacy `notification_roles` setting is intentionally ignored here:
    // we no longer fan out to every admin/manager because most managers
    // don't look after vehicles. Setting kept for backwards-compat reads.
    const { getVehicleNotificationTargets } = await import('./vehicle-notify');
    const { emailService } = await import('./email-service');
    const targets = await getVehicleNotificationTargets();

    const frontendUrl = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';

    for (const alert of alerts) {
      // Dedup is per-alert (not per-user) so we don't email info@ twice
      // when the same item is still due.
      const dedupDays = alert.urgency === 'overdue' ? 1 : 7;
      const existingAny = await query(
        `SELECT id FROM notifications
         WHERE type = 'compliance'
           AND entity_id = $1::uuid
           AND title LIKE $2
           AND created_at > NOW() - INTERVAL '1 day' * $3
         LIMIT 1`,
        [alert.vehicleId, `%${alert.item}%${alert.reg}%`, dedupDays]
      );
      if (existingAny.rows.length > 0) continue;

      const urgencyLabel = alert.urgency === 'overdue' ? 'OVERDUE' : 'Due soon';
      const daysText = alert.daysRemaining < 0
        ? `${Math.abs(alert.daysRemaining)} days overdue`
        : alert.daysRemaining === 0 ? 'due today'
        : `due in ${alert.daysRemaining} days`;

      // Direct email to info@ + will@ CC. Sent once per alert, regardless
      // of how many bell recipients we have.
      try {
        await emailService.send('compliance_reminder', {
          to: targets.to,
          cc: targets.cc,
          variables: {
            vehicleReg: alert.reg,
            vehicleName: alert.reg,
            dueType: alert.item,
            urgency: urgencyLabel,
            daysRemaining: daysText,
            vehicleUrl: `${frontendUrl}/vehicles/fleet/${alert.vehicleId}`,
          },
        });
      } catch (emailErr) {
        console.warn('[compliance-checker] Direct email failed:', (emailErr as Error).message);
      }

      // Bell notification(s) for the vehicle manager. Mark email_sent_at
      // so the escalation scheduler doesn't fire a duplicate email.
      for (const userId of targets.bellUserIds) {
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, email_sent_at)
           VALUES ($1, 'compliance', $2, $3, 'fleet_vehicles', $4, $5, $6, NOW())`,
          [
            userId,
            `${urgencyLabel}: ${alert.item} — ${alert.reg}`,
            `${alert.item} for ${alert.reg} is ${daysText} (${alert.date})`,
            alert.vehicleId,
            alert.urgency === 'overdue' ? 'high' : 'normal',
            `/vehicles/fleet/${alert.vehicleId}`,
          ]
        );
        notificationsCreated++;
      }
    }
  }

  return { alerts, notificationsCreated };
}
