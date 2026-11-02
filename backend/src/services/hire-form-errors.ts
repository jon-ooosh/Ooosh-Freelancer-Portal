/**
 * Errors reported by the driver hire form app — kept, and the critical ones emailed.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hire form (separate Netlify app, repo ooosh-driver-verification-) reports
 * anything that goes wrong for a driver through its `log-client-error`
 * function: a proof of address or DVLA upload that failed, the join-to-hire
 * call failing on the signature page, the DVLA data write being refused, a page
 * crash. Until Oct 2026 those went to a Google Apps Script meant to log them to
 * a "Health check" sheet and email the critical ones. Its doPost never handled
 * the 'log-error' action, so for as long as it existed nothing was logged and
 * nobody was told — a failed DVLA upload, for one, is invisible to the driver.
 *
 * WHAT HAPPENS NOW
 * ----------------
 * Every report is stored in `hire_form_error_events` (critical, warning and
 * info, including the session check's "would reject" lines). Only a CRITICAL
 * one emails info@ — the email is the action point; there is deliberately no
 * screen for this (jon, Oct 2026). The table is for looking things up.
 *
 * WHY TWO LIMITS
 * --------------
 * `log-client-error` is open to the internet (a driver has no session before
 * the email code), so anyone can post to it. The alerts are limited:
 *   - one email per driver per page per hour — a driver pressing Try again
 *     doesn't send ten; a DIFFERENT driver failing the same way still alerts;
 *   - at most MAX_ALERTS_PER_HOUR in total — so made-up page names can't
 *     flood the inbox. Anything over the limit is still stored.
 */

import { query } from '../config/database';
import { emailService } from './email-service';
import { frontendLink } from '../config/app-urls';

export const ALERT_TO = 'info@oooshtours.co.uk';
export const MAX_ALERTS_PER_HOUR = 10;

export type HireFormErrorSeverity = 'critical' | 'warning' | 'info';

export interface HireFormErrorReport {
  severity: HireFormErrorSeverity;
  page: string;
  error: string;
  email?: string | null;
  url?: string | null;
  userAgent?: string | null;
  additionalInfo?: string | null;
  /** When it happened in the driver's browser (ISO). Shown in the email only. */
  timestamp?: string | null;
}

/**
 * Should this report email info@? Pure, so the limits can be tested.
 * `sameDriverPageLastHour` / `totalLastHour` count alerts ALREADY sent.
 */
export function shouldAlert(
  severity: HireFormErrorSeverity,
  sameDriverPageLastHour: number,
  totalLastHour: number,
): boolean {
  if (severity !== 'critical') return false;
  if (sameDriverPageLastHour > 0) return false;
  return totalLastHour < MAX_ALERTS_PER_HOUR;
}

/** The job number from the form's URL (`?job=16281`), if there is one. */
export function jobNumberFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const match = /[?&]job=(\d{1,10})(?:&|#|$)/.exec(url);
  return match ? match[1] : null;
}

/** A real driver email, or null for the reporter's 'unknown' placeholder. */
export function realEmail(email?: string | null): string | null {
  const e = (email || '').trim().toLowerCase();
  return e && e !== 'unknown' && e.includes('@') ? e : null;
}

/**
 * Store a report and, if it qualifies, email info@. Never throws — the hire
 * form is told it was logged either way, and a failed email is only logged here.
 */
export async function recordHireFormError(report: HireFormErrorReport): Promise<{ id: string; alerted: boolean }> {
  const email = realEmail(report.email);
  const jobNumber = jobNumberFromUrl(report.url);

  let alerted = false;
  if (report.severity === 'critical') {
    const counts = await query(
      `SELECT
         COUNT(*) FILTER (WHERE page = $1 AND driver_email IS NOT DISTINCT FROM $2)::int AS same,
         COUNT(*)::int AS total
       FROM hire_form_error_events
       WHERE alerted AND created_at > NOW() - INTERVAL '1 hour'`,
      [report.page, email],
    );
    alerted = shouldAlert(report.severity, counts.rows[0].same, counts.rows[0].total);
  }

  const inserted = await query(
    `INSERT INTO hire_form_error_events
       (severity, page, error, driver_email, job_number, url, user_agent, additional_info, alerted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      report.severity,
      report.page,
      report.error,
      email,
      jobNumber,
      report.url || null,
      report.userAgent || null,
      report.additionalInfo || null,
      alerted,
    ],
  );
  const id = inserted.rows[0].id as string;

  if (alerted) {
    await sendAlert(report, email, jobNumber).catch((err) => {
      console.error('[hire-form-errors] alert email failed:', err);
    });
  }

  return { id, alerted };
}

async function sendAlert(report: HireFormErrorReport, email: string | null, jobNumber: string | null): Promise<void> {
  let driverName = '';
  let driverUrl = '';
  if (email) {
    const driver = await query(
      `SELECT id, full_name FROM drivers WHERE LOWER(email) = $1 AND is_active = true LIMIT 1`,
      [email],
    );
    if (driver.rows[0]) {
      driverName = driver.rows[0].full_name || '';
      driverUrl = frontendLink(`/drivers/${driver.rows[0].id}`);
    }
  }

  const when = report.timestamp ? new Date(report.timestamp) : new Date();
  const whenText = Number.isNaN(when.getTime())
    ? String(report.timestamp)
    : when.toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });

  const result = await emailService.send('hire_form_error_alert', {
    to: ALERT_TO,
    variables: {
      page: report.page,
      error: report.error,
      driverEmail: email || 'not known (before the email code)',
      driverName,
      driverUrl,
      jobNumber: jobNumber || '',
      when: whenText,
      details: report.additionalInfo || '',
    },
  });
  if (!result.success) {
    console.error('[hire-form-errors] alert email not sent:', result.error);
  }
}
