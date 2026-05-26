/**
 * Vehicle Compliance Checker — evaluates fleet compliance status and
 * creates notifications for overdue / soon-due items.
 *
 * Called daily by the scheduler at 08:00.
 * Dedup: won't create duplicate notifications within the dedup window
 * (7 days for 'soon', 1 day for 'overdue').
 *
 * Covers two families of check:
 *   - Date-based:    MOT, Tax, Insurance, TFL, and Rossetts (annual warranty
 *                    service for Mercedes/on-plan vans).
 *   - Mileage-based: general Service — alert when the van is within N miles of
 *                    its next_service_due reading.
 */

import { query } from '../config/database';

interface ComplianceAlert {
  vehicleId: string;
  reg: string;
  item: string;        // 'MOT', 'Tax', 'Insurance', 'TFL', 'Service', 'Rossetts Service'
  urgency: 'soon' | 'overdue';
  /** Pre-humanised summary, e.g. "5 days overdue" or "450 miles until service". */
  detail: string;
  /** YYYY-MM-DD for date-based checks; null for mileage-based. */
  date: string | null;
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
  // Service alerts (migration 088)
  service_mileage_warning_miles: number;
  rossetts_first_service_years: number;
  rossetts_interval_months: number;
  rossetts_warning_days: number;
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
    service_mileage_warning_miles: Number(settings.service_mileage_warning_miles) || 2000,
    rossetts_first_service_years: Number(settings.rossetts_first_service_years) || 3,
    rossetts_interval_months: Number(settings.rossetts_interval_months) || 12,
    rossetts_warning_days: Number(settings.rossetts_warning_days) || 30,
  };
}

/** Days between a target date and now (ceil — partial day counts as a day remaining). */
function daysUntil(target: Date, now: Date): number {
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

function ymd(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

function daysText(diffDays: number): string {
  if (diffDays < 0) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === 0) return 'due today';
  return `due in ${diffDays} days`;
}

/**
 * Run the compliance check — returns alerts and optionally creates notifications.
 */
export async function runComplianceCheck(createNotifications = true): Promise<{
  alerts: ComplianceAlert[];
  notificationsCreated: number;
}> {
  const settings = await getComplianceSettings();

  // Fetch all active vehicles with relevant date + service fields
  const vehicleResult = await query(
    `SELECT id, reg, mot_due, tax_due, insurance_due, tfl_due,
            next_service_due, current_mileage, service_booked_in_date,
            rossetts_applicable, last_rossetts_service_date, date_first_reg
     FROM fleet_vehicles
     WHERE is_active = true AND fleet_group != 'old_sold'`
  );

  const dateChecks: { label: string; field: string; warningDays: number; urgentDays: number }[] = [
    { label: 'MOT', field: 'mot_due', warningDays: settings.mot_warning_days, urgentDays: settings.mot_urgent_days },
    { label: 'Tax', field: 'tax_due', warningDays: settings.tax_warning_days, urgentDays: settings.tax_urgent_days },
    { label: 'Insurance', field: 'insurance_due', warningDays: settings.insurance_warning_days, urgentDays: settings.insurance_urgent_days },
    { label: 'TFL', field: 'tfl_due', warningDays: settings.tfl_warning_days, urgentDays: settings.tfl_urgent_days },
  ];

  const alerts: ComplianceAlert[] = [];
  const now = new Date();

  for (const vehicle of vehicleResult.rows) {
    const vehicleId = vehicle.id as string;
    const reg = vehicle.reg as string;

    // ── Date-based: MOT / Tax / Insurance / TFL ──
    for (const check of dateChecks) {
      const dateVal = vehicle[check.field];
      if (!dateVal) continue;

      const dueDate = new Date(dateVal as string);
      const diffDays = daysUntil(dueDate, now);

      if (diffDays < 0) {
        alerts.push({
          vehicleId, reg, item: check.label, urgency: 'overdue',
          detail: daysText(diffDays), date: ymd(dueDate as unknown as Date),
        });
      } else if (diffDays <= check.warningDays) {
        alerts.push({
          vehicleId, reg, item: check.label,
          urgency: diffDays <= check.urgentDays ? 'overdue' : 'soon',
          detail: daysText(diffDays), date: ymd(dueDate as unknown as Date),
        });
      }
    }

    // ── Mileage-based: general Service ──
    // Skip if a service is already booked in for the future — no point chasing
    // Will when he's already sorted it.
    const nextServiceDue = vehicle.next_service_due as number | null;
    const currentMileage = vehicle.current_mileage as number | null;
    const serviceBookedIn = vehicle.service_booked_in_date
      ? new Date(vehicle.service_booked_in_date as string)
      : null;
    const serviceBookedFuture = serviceBookedIn != null && daysUntil(serviceBookedIn, now) >= 0;

    if (nextServiceDue != null && nextServiceDue > 0 && currentMileage != null && !serviceBookedFuture) {
      const remaining = nextServiceDue - currentMileage;
      if (remaining <= settings.service_mileage_warning_miles) {
        alerts.push({
          vehicleId, reg, item: 'Service',
          urgency: remaining <= 0 ? 'overdue' : 'soon',
          detail: remaining <= 0
            ? `${Math.abs(remaining).toLocaleString()} miles overdue for service`
            : `${remaining.toLocaleString()} miles until service`,
          date: null,
        });
      }
    }

    // ── Date-based: Rossetts annual warranty service (Mercedes/on-plan only) ──
    if (vehicle.rossetts_applicable === true && !serviceBookedFuture) {
      let rossettsDue: Date | null = null;
      if (vehicle.last_rossetts_service_date) {
        rossettsDue = addMonths(new Date(vehicle.last_rossetts_service_date as string), settings.rossetts_interval_months);
      } else if (vehicle.date_first_reg) {
        rossettsDue = addYears(new Date(vehicle.date_first_reg as string), settings.rossetts_first_service_years);
      }

      if (rossettsDue) {
        const diffDays = daysUntil(rossettsDue, now);
        if (diffDays < 0 || diffDays <= settings.rossetts_warning_days) {
          alerts.push({
            vehicleId, reg, item: 'Rossetts Service',
            urgency: diffDays < 0 ? 'overdue' : 'soon',
            detail: daysText(diffDays), date: ymd(rossettsDue),
          });
        }
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
      // when the same item is still due. The leading ": " + " — " framing
      // disambiguates "Service" from "Rossetts Service" (the former would
      // otherwise substring-match the latter's title).
      const dedupDays = alert.urgency === 'overdue' ? 1 : 7;
      const existingAny = await query(
        `SELECT id FROM notifications
         WHERE type = 'compliance'
           AND entity_id = $1::uuid
           AND title LIKE $2
           AND created_at > NOW() - INTERVAL '1 day' * $3
         LIMIT 1`,
        [alert.vehicleId, `%: ${alert.item} — ${alert.reg}%`, dedupDays]
      );
      if (existingAny.rows.length > 0) continue;

      const urgencyLabel = alert.urgency === 'overdue' ? 'OVERDUE' : 'Due soon';

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
            daysRemaining: alert.detail,
            vehicleUrl: `${frontendUrl}/vehicles/fleet/${alert.vehicleId}`,
          },
        });
      } catch (emailErr) {
        console.warn('[compliance-checker] Direct email failed:', (emailErr as Error).message);
      }

      // Bell notification(s) for the vehicle manager. Mark email_sent_at
      // so the escalation scheduler doesn't fire a duplicate email.
      const contentDate = alert.date ? ` (${alert.date})` : '';
      for (const userId of targets.bellUserIds) {
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, email_sent_at)
           VALUES ($1, 'compliance', $2, $3, 'fleet_vehicles', $4, $5, $6, NOW())`,
          [
            userId,
            `${urgencyLabel}: ${alert.item} — ${alert.reg}`,
            `${alert.item} for ${alert.reg} is ${alert.detail}${contentDate}`,
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
