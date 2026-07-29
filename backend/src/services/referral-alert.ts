// ============================================================================
// Insurance referral alert — shared, idempotent send (jon, Jul 2026)
// ============================================================================
//
// The `referral_alert` email (with the driver-verification snapshot PDF
// attached) goes to the vehicle-notification targets (info@ + will@) whenever
// a driver is flagged `requires_referral = true`.
//
// Historically this fired from EXACTLY ONE place — POST /api/hire-forms. A
// driver whose SignaturePage chain terminated at POST /api/driver-verification/update
// (a known intermittent gap) set the flag + got a bell for the vehicle
// manager, but no email ever went out (Meadham / HH 16330 incident, Jul 2026).
//
// This helper centralises the send and is called from THREE paths:
//   1. POST /api/hire-forms                       (full form submitted)
//   2. POST /api/driver-verification/update       (signature step reached)
//   3. Daily safety-net scanner                   (services/scheduler.ts)
//
// Idempotency: `drivers.referral_alert_sent_at` (migration 186) is claimed
// with a conditional UPDATE BEFORE the send. Whichever path completes first
// wins the claim; the others (and the scanner) find the stamp set and skip.
// The claim is released on any send failure so a retry / later path can
// re-claim and try again.
// ============================================================================

import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { decryptDriverRow } from './driver-pii';

export interface ReferralAlertResult {
  sent: boolean;
  reason?: 'already_sent' | 'not_required' | 'not_found' | 'send_failed';
}

/**
 * Fire the `referral_alert` email for a driver, exactly once.
 *
 * @param driverId       drivers.id
 * @param hirehopJobId   optional HH job number for the email + PDF context
 * @param referralReason optional free-text reason to lead the reasons list
 * @param force          bypass the once-only claim (manual re-send). Default false.
 */
export async function sendReferralAlert(
  driverId: string,
  opts: { hirehopJobId?: number | null; referralReason?: string; force?: boolean } = {}
): Promise<ReferralAlertResult> {
  const { hirehopJobId = null, referralReason = '', force = false } = opts;

  // ── 1. Atomic claim ────────────────────────────────────────────────────
  // Only proceed if the driver still requires a referral AND the alert
  // hasn't already been sent (unless force). rowCount === 0 means another
  // path beat us to it, or the flag has since been cleared.
  if (!force) {
    const claim = await query(
      `UPDATE drivers
         SET referral_alert_sent_at = NOW()
       WHERE id = $1
         AND requires_referral = true
         AND referral_alert_sent_at IS NULL
       RETURNING id`,
      [driverId]
    );
    if (claim.rows.length === 0) {
      // Distinguish "already sent" from "not (or no longer) required".
      const check = await query(
        `SELECT requires_referral, referral_alert_sent_at FROM drivers WHERE id = $1`,
        [driverId]
      );
      if (check.rows.length === 0) return { sent: false, reason: 'not_found' };
      if (!check.rows[0].requires_referral) return { sent: false, reason: 'not_required' };
      return { sent: false, reason: 'already_sent' };
    }
  } else {
    // Force path (manual re-send): stamp without the once-only guard.
    await query(`UPDATE drivers SET referral_alert_sent_at = NOW() WHERE id = $1`, [driverId]);
  }

  try {
    await buildAndSend(driverId, referralReason, hirehopJobId);
    return { sent: true };
  } catch (err) {
    // Release the claim so a retry / later path can re-attempt.
    if (!force) {
      await query(
        `UPDATE drivers SET referral_alert_sent_at = NULL WHERE id = $1`,
        [driverId]
      ).catch(() => { /* best-effort release */ });
    }
    console.error('[referral-alert] Failed to send referral alert:', err);
    return { sent: false, reason: 'send_failed' };
  }
}

async function buildAndSend(
  driverId: string,
  referralReason: string,
  hirehopJobId: number | null
): Promise<void> {
  // Build referral reasons list from driver data
  const driverResult = await query(
    `SELECT d.*,
      COALESCE(
        (SELECT string_agg(CONCAT('#', vha.hirehop_job_id, ' ', vha.hirehop_job_name), ', ')
         FROM vehicle_hire_assignments vha
         WHERE vha.driver_id = d.id AND vha.status IN ('soft', 'confirmed', 'booked_out', 'active')),
        'No active hires'
      ) AS linked_jobs
    FROM drivers d WHERE d.id = $1`,
    [driverId]
  );

  if (driverResult.rows.length === 0) {
    throw new Error(`Driver ${driverId} not found when building referral alert`);
  }
  const driver = decryptDriverRow(driverResult.rows[0]);

  const driverName: string = driver.full_name || 'Unknown';
  const driverEmail: string = driver.email || 'N/A';

  // Derive the HH job number from the most recent active assignment when the
  // caller didn't pass one (e.g. the signature-step trigger, whose update
  // payload carries no job number).
  if (hirehopJobId === null) {
    const jobRow = await query(
      `SELECT hirehop_job_id
         FROM vehicle_hire_assignments
        WHERE driver_id = $1 AND status IN ('soft', 'confirmed', 'booked_out', 'active')
        ORDER BY created_at DESC
        LIMIT 1`,
      [driverId]
    );
    hirehopJobId = jobRow.rows[0]?.hirehop_job_id ?? null;
  }

  // Build human-readable reasons
  const reasons: string[] = [];
  if (referralReason) reasons.push(referralReason);
  if (driver.referral_notes && driver.referral_notes !== referralReason) reasons.push(driver.referral_notes);
  if (driver.has_disability) reasons.push('Declared disability/medical condition');
  if (driver.has_convictions) reasons.push('Declared motoring convictions');
  if (driver.has_prosecution) reasons.push('Declared pending prosecution');
  if (driver.has_accidents) reasons.push('Declared previous accidents');
  if (driver.has_insurance_issues) reasons.push('Declared insurance issues');
  if (driver.has_driving_ban) reasons.push('Declared previous driving ban');
  if (driver.licence_points >= 9) reasons.push(`${driver.licence_points} penalty points on licence`);
  if (driver.licence_issue_country && !['GB', 'UK', 'DVLA'].includes(String(driver.licence_issue_country).toUpperCase())) {
    reasons.push(`Non-standard licence country: ${driver.licence_issue_country}`);
  }
  if (reasons.length === 0) reasons.push('Flagged by hire form verification process');

  const frontendUrl = getFrontendUrl();

  // Try to generate snapshot PDF for attachment
  let attachments: Array<{ filename: string; content: Buffer; contentType: string }> | undefined;
  try {
    const { generateDriverSnapshot, loadDriverDocuments } = await import('./driver-snapshot-pdf');
    const { fetchLogo } = await import('./hire-form-pdf');

    const documents = await loadDriverDocuments(driver.files || []);
    let logoImage: Buffer | null = null;
    try { logoImage = await fetchLogo(); } catch { /* skip */ }

    const isUk = (driver.licence_issue_country || '').toUpperCase() === 'GB' ||
      (driver.licence_issued_by || '').toUpperCase().includes('DVLA');

    const snapshotData = {
      driverName: driver.full_name || driverName,
      email: driver.email || driverEmail,
      phone: driver.phone ? `${driver.phone_country || ''} ${driver.phone}` : '',
      dateOfBirth: driver.date_of_birth || '',
      nationality: driver.nationality || '',
      homeAddress: driver.address_full || [driver.address_line1, driver.address_line2, driver.city, driver.postcode].filter(Boolean).join(', '),
      licenceAddress: driver.licence_address || '',
      licenceNumber: driver.licence_number || '',
      licenceIssuedBy: driver.licence_issued_by || driver.licence_issue_country || '',
      licenceValidTo: driver.licence_valid_to || '',
      datePassedTest: driver.date_passed_test || '',
      dvlaPoints: String(driver.licence_points || 0),
      dvlaEndorsements: Array.isArray(driver.licence_endorsements)
        ? driver.licence_endorsements.map((e: any) => e.code).join(', ') || 'None'
        : 'None',
      calculatedExcess: '',
      isUkDriver: isUk,
      hasDisability: driver.has_disability || false,
      hasConvictions: driver.has_convictions || false,
      hasProsecution: driver.has_prosecution || false,
      hasAccidents: driver.has_accidents || false,
      hasInsuranceIssues: driver.has_insurance_issues || false,
      hasDrivingBan: driver.has_driving_ban || false,
      additionalDetails: driver.additional_details || '',
      jobId: hirehopJobId ? String(hirehopJobId) : 'N/A',
      documents,
      logoImage,
    };

    const { pdfBytes, filename } = await generateDriverSnapshot(snapshotData);
    attachments = [{ filename, content: Buffer.from(pdfBytes), contentType: 'application/pdf' }];
    console.log(`[referral-alert] Snapshot PDF generated for referral email: ${filename}`);
  } catch (snapshotErr) {
    console.warn('[referral-alert] Could not generate snapshot PDF for referral email:', (snapshotErr as Error).message);
  }

  const { getVehicleNotificationTargets } = await import('./vehicle-notify');
  const vehicleTargets = await getVehicleNotificationTargets();
  await emailService.send('referral_alert', {
    to: vehicleTargets.to,
    cc: vehicleTargets.cc,
    variables: {
      driverName,
      driverEmail,
      jobNumber: hirehopJobId ? String(hirehopJobId) : 'N/A',
      referralReasons: reasons.map(r => `• ${r}`).join('<br/>'),
      linkedJobs: driver.linked_jobs || 'No active hires',
      driverUrl: `${frontendUrl}/drivers/${driverId}`,
    },
    attachments,
  });

  console.log(`[referral-alert] Referral alert email sent for driver ${driverName} (${driverId})`);
}

/**
 * Safety-net scanner. Finds drivers flagged `requires_referral = true` who
 * signed a hire form recently but never got the referral alert email (the
 * SignaturePage chain reached neither POST /api/hire-forms nor the
 * driver-verification signature step's email trigger). Fires the alert.
 *
 * Bounded to the last N days so it never spams an ancient backlog. Idempotent
 * via the `referral_alert_sent_at` claim inside sendReferralAlert.
 */
export async function runReferralAlertScan(lookbackDays = 14): Promise<{ checked: number; sent: number }> {
  const candidates = await query(
    `SELECT id
       FROM drivers
      WHERE requires_referral = true
        AND referral_alert_sent_at IS NULL
        AND signature_date IS NOT NULL
        AND signature_date >= (CURRENT_DATE - ($1 || ' days')::interval)::date`,
    [String(lookbackDays)]
  );

  let sent = 0;
  for (const row of candidates.rows) {
    // hirehopJobId is derived inside sendReferralAlert from the driver's most
    // recent active assignment.
    const result = await sendReferralAlert(row.id);
    if (result.sent) sent++;
  }

  return { checked: candidates.rows.length, sent };
}
