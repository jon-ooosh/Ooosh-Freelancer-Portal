/**
 * Out-of-Hours return helper.
 *
 * Sends the initial info email + day-before reminder + handles the public
 * parking-confirmation flow. Per-van scope (one email per van, addressed
 * to all drivers on that van).
 *
 * Triggers (all non-blocking; errors logged not thrown):
 *   1. sendOohInfoEmailsForJob()      — fired from book-out submit + manual resend
 *   2. sendOohReminderEmails()        — daily scheduler, 10:00, T-1 day
 *   3. recordOohParkingSubmission()   — public form callback
 */
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { getSystemSettings } from '../routes/system-settings';

interface OohContext {
  assignmentId: string;
  vehicleReg: string;
  vehicleId: string | null;
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  hireEnd: string | null;
  driverEmail: string | null;
  driverName: string | null;
  parkingToken: string;
}

/**
 * Generate a unique random parking token (URL-safe base64).
 */
function newParkingToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Look up the per-vehicle group of OOH assignments for a given job. Returns
 * one entry per (job, vehicle) pair. Each entry contains the lead assignment
 * (lowest van_requirement_index) plus all sibling drivers on the same van.
 */
async function loadOohAssignmentsForJob(jobId: string): Promise<{
  vehicleId: string | null;
  vehicleReg: string;
  hireEnd: string | null;
  jobName: string | null;
  hhJobNumber: number | null;
  drivers: Array<{
    assignmentId: string;
    parkingToken: string;
    driverEmail: string | null;
    driverName: string | null;
    infoSentAt: Date | null;
  }>;
}[]> {
  const result = await query(
    `SELECT
       vha.id              AS assignment_id,
       vha.vehicle_id      AS vehicle_id,
       fv.reg              AS vehicle_reg,
       vha.hire_end::text  AS hire_end,
       d.email             AS driver_email,
       d.full_name         AS driver_name,
       vha.ooh_info_sent_at AS info_sent_at,
       vha.ooh_parking_token AS parking_token,
       j.job_name,
       j.hh_job_number
     FROM vehicle_hire_assignments vha
     JOIN jobs j ON j.id = vha.job_id
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.job_id = $1
       AND vha.return_overnight = TRUE
       AND vha.status IN ('booked_out', 'active', 'soft', 'confirmed')
       AND vha.vehicle_id IS NOT NULL
     ORDER BY vha.vehicle_id, vha.van_requirement_index NULLS LAST, vha.created_at ASC`,
    [jobId]
  );

  interface Row {
    assignment_id: string;
    vehicle_id: string | null;
    vehicle_reg: string;
    hire_end: string | null;
    driver_email: string | null;
    driver_name: string | null;
    info_sent_at: Date | null;
    parking_token: string | null;
    job_name: string | null;
    hh_job_number: number | null;
  }
  const rows = result.rows as Row[];

  // Group by vehicle_id
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = row.vehicle_id ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.values()).map(grp => ({
    vehicleId: grp[0].vehicle_id,
    vehicleReg: grp[0].vehicle_reg,
    hireEnd: grp[0].hire_end,
    jobName: grp[0].job_name,
    hhJobNumber: grp[0].hh_job_number,
    drivers: grp.map(r => ({
      assignmentId: r.assignment_id,
      parkingToken: r.parking_token ?? '',
      driverEmail: r.driver_email,
      driverName: r.driver_name,
      infoSentAt: r.info_sent_at,
    })),
  }));
}

/**
 * Ensure every driver row in the group has a parking token. Returns
 * the updated rows (with tokens guaranteed non-empty).
 */
async function ensureParkingTokens(
  drivers: Array<{ assignmentId: string; parkingToken: string }>
): Promise<void> {
  for (const d of drivers) {
    if (!d.parkingToken) {
      const token = newParkingToken();
      await query(
        `UPDATE vehicle_hire_assignments SET ooh_parking_token = $1 WHERE id = $2`,
        [token, d.assignmentId]
      );
      d.parkingToken = token;
    }
  }
}

/**
 * Build the body variables for the info / reminder email. Reads OOH config
 * from system_settings.
 */
async function buildEmailVariables(ctx: OohContext): Promise<Record<string, string>> {
  const settings = await getSystemSettings([
    'ooh_gate_code',
    'ooh_yard_address',
    'ooh_yard_maps_url',
    'ooh_keydrop_photo_url',
    'ooh_what3words',
  ]);

  const frontendUrl = getFrontendUrl();
  const parkingFormUrl = `${frontendUrl}/return-parking/${ctx.parkingToken}`;

  // Pass primitives only — the template owns the HTML structure and uses
  // {{#if varName}}...{{/if}} blocks to conditionally render the wrapping
  // markup for optional values. Building HTML strings here would get
  // double-escaped by the template substituter.
  return {
    driverName: ctx.driverName || 'there',
    vehicleReg: ctx.vehicleReg,
    jobNumber: String(ctx.hhJobNumber ?? ''),
    gateCode: settings.ooh_gate_code || '—',
    yardAddress: settings.ooh_yard_address || 'Ooosh Tours',
    yardMapsUrl: settings.ooh_yard_maps_url || '',
    what3words: settings.ooh_what3words || '',
    keydropPhotoUrl: settings.ooh_keydrop_photo_url || '',
    parkingFormUrl,
  };
}

/**
 * Send the initial OOH info email for every van on a job that has
 * return_overnight=true. Idempotent — skips drivers who already have
 * ooh_info_sent_at set, unless force=true.
 *
 * Returns a summary of what was sent.
 */
export async function sendOohInfoEmailsForJob(
  jobId: string,
  opts: { force?: boolean } = {}
): Promise<{ vehicleCount: number; emailsSent: number; emailsSkipped: number }> {
  const groups = await loadOohAssignmentsForJob(jobId);
  let emailsSent = 0;
  let emailsSkipped = 0;

  for (const group of groups) {
    await ensureParkingTokens(group.drivers);

    for (const driver of group.drivers) {
      if (!driver.driverEmail) {
        emailsSkipped++;
        continue;
      }
      if (driver.infoSentAt && !opts.force) {
        emailsSkipped++;
        continue;
      }

      try {
        const ctx: OohContext = {
          assignmentId: driver.assignmentId,
          vehicleReg: group.vehicleReg,
          vehicleId: group.vehicleId,
          jobId,
          hhJobNumber: group.hhJobNumber,
          jobName: group.jobName,
          hireEnd: group.hireEnd,
          driverEmail: driver.driverEmail,
          driverName: driver.driverName,
          parkingToken: driver.parkingToken,
        };
        const variables = await buildEmailVariables(ctx);

        const result = await emailService.send('ooh_return_info', {
          to: driver.driverEmail,
          variables,
        });

        if (result.success) {
          await query(
            `UPDATE vehicle_hire_assignments SET ooh_info_sent_at = NOW() WHERE id = $1`,
            [driver.assignmentId]
          );
          emailsSent++;
        } else {
          console.warn(`[ooh-return] info email failed for assignment ${driver.assignmentId}:`, result.error);
          emailsSkipped++;
        }
      } catch (err) {
        console.error(`[ooh-return] info email error for assignment ${driver.assignmentId}:`, err);
        emailsSkipped++;
      }
    }
  }

  return { vehicleCount: groups.length, emailsSent, emailsSkipped };
}

/**
 * Daily scheduler task: find assignments with return_overnight=true,
 * hire_end = tomorrow, and ooh_reminder_sent_at IS NULL.
 * Send the reminder email + flag the row.
 */
export async function sendOohReminderEmails(): Promise<{ sent: number; skipped: number }> {
  const result = await query(
    `SELECT
       vha.id AS assignment_id,
       fv.reg AS vehicle_reg,
       vha.job_id,
       j.hh_job_number,
       j.job_name,
       vha.hire_end::text AS hire_end,
       d.email AS driver_email,
       d.full_name AS driver_name,
       vha.ooh_parking_token AS parking_token
     FROM vehicle_hire_assignments vha
     JOIN jobs j ON j.id = vha.job_id
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.return_overnight = TRUE
       AND vha.ooh_reminder_sent_at IS NULL
       AND vha.status IN ('booked_out', 'active')
       AND vha.hire_end = (CURRENT_DATE + INTERVAL '1 day')::date
       AND vha.vehicle_id IS NOT NULL`
  );

  let sent = 0;
  let skipped = 0;

  interface ReminderRow {
    assignment_id: string;
    vehicle_reg: string;
    job_id: string;
    hh_job_number: number | null;
    job_name: string | null;
    hire_end: string | null;
    driver_email: string | null;
    driver_name: string | null;
    parking_token: string | null;
  }
  for (const row of result.rows as ReminderRow[]) {
    if (!row.driver_email) {
      skipped++;
      continue;
    }

    let token = row.parking_token;
    if (!token) {
      token = newParkingToken();
      await query(
        `UPDATE vehicle_hire_assignments SET ooh_parking_token = $1 WHERE id = $2`,
        [token, row.assignment_id]
      );
    }

    try {
      const ctx: OohContext = {
        assignmentId: row.assignment_id,
        vehicleReg: row.vehicle_reg,
        vehicleId: null,
        jobId: row.job_id,
        hhJobNumber: row.hh_job_number,
        jobName: row.job_name,
        hireEnd: row.hire_end,
        driverEmail: row.driver_email,
        driverName: row.driver_name,
        parkingToken: token,
      };
      const variables = await buildEmailVariables(ctx);

      const sendResult = await emailService.send('ooh_return_reminder', {
        to: row.driver_email,
        variables,
      });

      if (sendResult.success) {
        await query(
          `UPDATE vehicle_hire_assignments SET ooh_reminder_sent_at = NOW() WHERE id = $1`,
          [row.assignment_id]
        );
        sent++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[ooh-return] reminder email error for assignment ${row.assignment_id}:`, err);
      skipped++;
    }
  }

  if (sent > 0 || skipped > 0) {
    console.log(`[ooh-return] reminder run: ${sent} sent, ${skipped} skipped`);
  }
  return { sent, skipped };
}

/**
 * Resolve a public parking token to an assignment + context.
 * Returns null if token unknown or assignment is no longer on hire.
 */
export async function resolveParkingToken(token: string): Promise<{
  assignmentId: string;
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  vehicleId: string | null;
  vehicleReg: string;
  driverName: string | null;
  status: string;
  alreadySubmitted: boolean;
} | null> {
  if (!token || token.length < 16 || token.length > 64) return null;

  const result = await query(
    `SELECT
       vha.id AS assignment_id,
       vha.job_id,
       j.hh_job_number,
       j.job_name,
       vha.vehicle_id,
       fv.reg AS vehicle_reg,
       d.full_name AS driver_name,
       vha.status,
       vha.ooh_returned_at
     FROM vehicle_hire_assignments vha
     JOIN jobs j ON j.id = vha.job_id
     LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE vha.ooh_parking_token = $1
     LIMIT 1`,
    [token]
  );

  interface TokenRow {
    assignment_id: string;
    job_id: string;
    hh_job_number: number | null;
    job_name: string | null;
    vehicle_id: string | null;
    vehicle_reg: string;
    driver_name: string | null;
    status: string;
    ooh_returned_at: Date | null;
  }
  const row = result.rows[0] as TokenRow | undefined;
  if (!row) return null;
  if (!['booked_out', 'active'].includes(row.status)) {
    // Token is dead — assignment is checked in or cancelled.
    return null;
  }

  return {
    assignmentId: row.assignment_id,
    jobId: row.job_id,
    hhJobNumber: row.hh_job_number,
    jobName: row.job_name,
    vehicleId: row.vehicle_id,
    vehicleReg: row.vehicle_reg,
    driverName: row.driver_name,
    status: row.status,
    alreadySubmitted: !!row.ooh_returned_at,
  };
}

/**
 * Persist the parking-form submission. Writes lat/lng/notes, sets
 * ooh_returned_at, logs an interaction on the job timeline, and
 * (when configured) emails info@ for visibility.
 */
export async function recordOohParkingSubmission(opts: {
  assignmentId: string;
  jobId: string;
  hhJobNumber: number | null;
  vehicleReg: string;
  driverName: string | null;
  lat: number;
  lng: number;
  notes: string | null;
  isResubmission: boolean;
}): Promise<void> {
  await query(
    `UPDATE vehicle_hire_assignments
       SET ooh_returned_at = COALESCE(ooh_returned_at, NOW()),
           ooh_parking_lat = $1,
           ooh_parking_lng = $2,
           ooh_parking_notes = $3,
           updated_at = NOW()
     WHERE id = $4`,
    [opts.lat, opts.lng, opts.notes, opts.assignmentId]
  );

  // Activity timeline interaction (uses the SYSTEM service user)
  const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
  const mapsLink = `https://www.google.com/maps?q=${opts.lat},${opts.lng}`;
  const submittedBy = opts.driverName || 'Driver';
  const noteSnippet = opts.notes ? ` Notes: ${opts.notes.slice(0, 200)}.` : '';

  try {
    await query(
      `INSERT INTO interactions (job_id, type, content, created_by)
       VALUES ($1, 'note', $2, $3)`,
      [
        opts.jobId,
        `🌙 OOH return: ${submittedBy} parked ${opts.vehicleReg}.${noteSnippet} Location: ${mapsLink}${opts.isResubmission ? ' (updated)' : ''}`,
        SYSTEM_USER_ID,
      ]
    );
  } catch (err) {
    console.warn(`[ooh-return] failed to log interaction for assignment ${opts.assignmentId}:`, err);
  }

  // CC info@ if enabled
  const ccSetting = await getSystemSettings(['ooh_cc_info_email']);
  if (ccSetting.ooh_cc_info_email !== 'false' && !opts.isResubmission) {
    try {
      const frontendUrl = getFrontendUrl();
      await emailService.send('ooh_return_received_internal', {
        to: 'info@oooshtours.co.uk',
        variables: {
          driverName: submittedBy,
          vehicleReg: opts.vehicleReg,
          jobNumber: String(opts.hhJobNumber ?? ''),
          submittedAt: new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          coordsLine: `${opts.lat.toFixed(5)}, ${opts.lng.toFixed(5)}`,
          mapsLink,
          notes: opts.notes || '',
          jobUrl: `${frontendUrl}/jobs/${opts.jobId}`,
        },
      });
    } catch (err) {
      console.warn(`[ooh-return] info@ alert email failed:`, err);
    }
  }
}
