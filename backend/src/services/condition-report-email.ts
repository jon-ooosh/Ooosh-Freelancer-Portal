/**
 * Condition-report email content — subject + HTML body for the vehicle
 * book-out / check-in condition report emails.
 *
 * Ported verbatim from the frontend's `pdf-email.ts` buildEmailHtml() when
 * the send-condition-report endpoint moved PDF generation + emailing fully
 * server-side (Jun 2026). The frontend used to generate one PDF per driver,
 * download each 7-9MB base64 response, and re-upload it to /send-email —
 * the server-side loop sends the photo set up once and builds/emails every
 * driver's copy here.
 *
 * Keep this in sync with the legacy frontend builder until CollectionPage
 * and the offline sync-processors are migrated off the old two-step flow.
 */

export interface ConditionReportEmailParams {
  vehicleReg: string;
  driverName: string;
  eventDate: string;
  isCheckIn?: boolean;
  driverPresent?: boolean;
  hireHopJob?: string | null;
  damageCount?: number;
  fuelDifference?: string | null; // e.g. "Full -> 3/8"
  milesDriven?: number | null;
}

function formatDateShort(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** ASCII-safe subject line (no em-dashes) — matches the legacy frontend format. */
export function buildConditionReportSubject(params: ConditionReportEmailParams): string {
  const reportType = params.isCheckIn ? 'Check-In Report' : 'Condition Report';
  const jobPart = params.hireHopJob ? ` ${params.hireHopJob}` : '';
  return `Vehicle ${reportType}${jobPart} - ${params.vehicleReg} - ${formatDateShort(params.eventDate)}`;
}

export function buildConditionReportEmailHtml(params: ConditionReportEmailParams): string {
  const date = formatDateShort(params.eventDate);

  if (params.isCheckIn) {
    return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #1b2a4e; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; font-size: 20px; margin: 0;">Vehicle Check-In Report</h1>
        <p style="color: #b4bed2; font-size: 13px; margin: 8px 0 0;">Return Record</p>
      </div>

      <div style="padding: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Hi ${params.driverName},
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please find attached the vehicle check-in report for <strong>${params.vehicleReg}</strong>,
          recorded on <strong>${date}</strong>.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          This report documents the condition of the vehicle at the end of the hire,
          including any changes from the original book-out condition.
        </p>${params.milesDriven != null ? `
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Total miles driven: <strong>${params.milesDriven.toLocaleString()} miles</strong>
        </p>` : ''}${params.damageCount && params.damageCount > 0 ? `
        <div style="margin: 0 0 16px; padding: 12px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;">
          <p style="margin: 0; font-size: 14px; color: #991b1b;">
            <strong>Damage Reported:</strong> ${params.damageCount} damage item${params.damageCount > 1 ? 's' : ''} ${params.damageCount > 1 ? 'were' : 'was'} recorded during this check-in.
            Please review the attached PDF report for full details and photographs.
          </p>
        </div>` : ''}${params.fuelDifference ? `
        <div style="margin: 0 0 16px; padding: 12px; background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 6px;">
          <p style="margin: 0; font-size: 14px; color: #92400e;">
            <strong>Fuel Difference:</strong> The vehicle was returned with a different fuel level than at book-out (${params.fuelDifference}).
          </p>
        </div>` : ''}${params.driverPresent === false ? `
        <p style="margin: 0 0 16px; padding: 12px; background-color: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 13px; color: #92400e;">
          <strong>Note:</strong> The driver was not present at the time of check-in.
          The vehicle was inspected without the driver in attendance.
        </p>` : ''}
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please review the attached PDF and contact us if you have any queries.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Thank you for choosing Ooosh Tours!
        </p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #374151;">
          If you have any questions, please call us on <strong>+44 (0) 1273 911382</strong>
          or email <a href="mailto:info@oooshtours.co.uk" style="color: #1b2a4e;">info@oooshtours.co.uk</a>.
        </p>
      </div>

      <div style="padding: 16px 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">
          Ooosh Tours Ltd
        </p>
        <p style="margin: 4px 0 0; font-size: 11px; color: #d1d5db;">
          This is an automated message. Please do not reply directly to this email.
        </p>
      </div>
    </div>
    `;
  }

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #1b2a4e; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; font-size: 20px; margin: 0;">Vehicle Condition Report</h1>
        <p style="color: #b4bed2; font-size: 13px; margin: 8px 0 0;">Book-Out Record</p>
      </div>

      <div style="padding: 24px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Hi ${params.driverName},
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please find attached the vehicle condition report for <strong>${params.vehicleReg}</strong>${params.hireHopJob ? ` on job number <strong>${params.hireHopJob}</strong>` : ''},
          recorded on <strong>${date}</strong>.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          This report documents the condition of the vehicle at the start of the hire,
          including mileage, fuel level, and condition photographs.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          Please review the attached PDF and contact us if you have any questions.
        </p>
        <p style="margin: 0 0 16px; font-size: 14px; color: #374151;">
          We hope you have a great tour!
        </p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #374151;">
          If you have any problems, please call us on <strong>+44 (0) 1273 911382</strong>
          or email <a href="mailto:info@oooshtours.co.uk" style="color: #1b2a4e;">info@oooshtours.co.uk</a>.
          If you have an out-of-hours emergency our number is <strong>+44 (0) 333 2079654</strong>.
        </p>
      </div>

      <div style="padding: 16px 24px; background: #ffffff; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0; font-size: 12px; color: #9ca3af;">
          Ooosh Tours Ltd
        </p>
        <p style="margin: 4px 0 0; font-size: 11px; color: #d1d5db;">
          This is an automated message. Please do not reply directly to this email.
        </p>
      </div>
    </div>
  `;
}
