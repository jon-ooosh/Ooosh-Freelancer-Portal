/**
 * Identity review — staff adjudication of a failed iDenfy face match.
 *
 * WHY THIS EXISTS
 * ---------------
 * iDenfy compares the driver's selfie against their licence photo and returns a
 * verdict. The webhook computed that verdict and threw it away, so a mismatch
 * had no effect: a SUSPECTED result still wrote every licence field and the
 * driver sailed through, while a DENIED result wrote a bare check date and
 * looped them back into iDenfy forever. Neither path consulted the face result.
 *
 * A mismatch is usually innocent — an older driver whose appearance has moved
 * on from their licence photo is the common case, not fraud. So this is not a
 * rejection: it is a "someone must look at this" state, deliberately modelled
 * on the insurance-referral flow so staff meet ONE pattern for "a human has to
 * decide" rather than two.
 *
 * WHY NOT REUSE requires_referral
 * -------------------------------
 * Same shape, different resolver. A referral is answered by the insurer, over
 * days, about the person's risk. This is answered by whoever is on the desk, in
 * seconds, by looking at two photographs. Overloading one flag would make
 * "referred" mean two unrelated things and muddle the audit trail.
 *
 * EFFECT (matches a pending referral)
 * -----------------------------------
 *   - blocks POST /api/hire-forms/quick-assign
 *   - withholds the hire agreement (isDriverAuthorisedForAgreement)
 *   - amber banner on the driver + the job's Drivers & Vehicles tab
 *   - one email to the vehicle-notification targets (info@ + will@)
 */

import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { getVehicleNotificationTargets } from './vehicle-notify';

export type IdentityCheckStatus = 'needs_review' | 'accepted' | 'rejected';

/** Verdicts iDenfy reports when the selfie did NOT match the document photo. */
const FACE_MISMATCH_RESULTS = new Set([
  'FACE_MISMATCH',
  'NO_FACE_FOUND',
  'TOO_MANY_FACES',
  'FACE_TOO_BLURRY',
  'AUTO_UNVERIFIABLE',
]);

/**
 * Does this iDenfy verdict need a human to look at it?
 *
 * Conservative on purpose: only an explicit non-match trips review. An
 * `undefined`/absent face result (iDenfy did not run the comparison — e.g. a
 * passport-only session) is NOT treated as a failure, or every second-document
 * upload would raise a false flag.
 */
export function faceNeedsReview(faceResult: string | null | undefined): boolean {
  if (!faceResult) return false;
  return FACE_MISMATCH_RESULTS.has(faceResult.toUpperCase().trim());
}

/**
 * True when the driver may be assigned / receive paperwork.
 *
 * Mirrors isDriverAuthorisedForAgreement's fail-open stance: an unknown or
 * missing status is authorised. Only an explicit `needs_review` or `rejected`
 * holds them back, so this can never silently block a driver over a data gap.
 */
export function isIdentityAuthorised(status: string | null | undefined): boolean {
  return status !== 'needs_review' && status !== 'rejected';
}

/** Staff-facing explanation for a held-back driver. */
export function identityHoldReason(status: string | null | undefined): string | null {
  if (status === 'needs_review') {
    return 'Photo ID check needs manual review — compare the selfie against the licence photo on the driver record.';
  }
  if (status === 'rejected') {
    return 'Photo ID check was rejected on review — this driver is not authorised.';
  }
  return null;
}

export interface IdentityAlertResult {
  sent: boolean;
  reason?: 'already_sent' | 'not_required' | 'not_found' | 'send_failed';
}

/**
 * Email the vehicle-notification targets that a driver needs an ID review.
 *
 * Once-only via an atomic claim on `identity_alert_sent_at`, released on send
 * failure so a retry can re-claim — the same discipline as sendReferralAlert.
 */
export async function sendIdentityReviewAlert(
  driverId: string,
  opts: { force?: boolean } = {},
): Promise<IdentityAlertResult> {
  const { force = false } = opts;

  if (!force) {
    const claim = await query(
      `UPDATE drivers
          SET identity_alert_sent_at = NOW()
        WHERE id = $1
          AND identity_check_status = 'needs_review'
          AND identity_alert_sent_at IS NULL
        RETURNING id`,
      [driverId],
    );
    if (claim.rows.length === 0) {
      const check = await query(
        `SELECT identity_check_status, identity_alert_sent_at FROM drivers WHERE id = $1`,
        [driverId],
      );
      if (check.rows.length === 0) return { sent: false, reason: 'not_found' };
      if (check.rows[0].identity_check_status !== 'needs_review') {
        return { sent: false, reason: 'not_required' };
      }
      return { sent: false, reason: 'already_sent' };
    }
  } else {
    await query(`UPDATE drivers SET identity_alert_sent_at = NOW() WHERE id = $1`, [driverId]);
  }

  try {
    const res = await query(
      `SELECT id, full_name, email, current_job_number,
              idenfy_overall, idenfy_face_result, idenfy_doc_result,
              idenfy_mismatch_tags, idenfy_suspicion_reasons
         FROM drivers WHERE id = $1`,
      [driverId],
    );
    if (res.rows.length === 0) throw new Error(`Driver ${driverId} not found`);
    const d = res.rows[0];

    const detail: string[] = [];
    if (d.idenfy_overall) detail.push(`iDenfy result: <strong>${d.idenfy_overall}</strong>`);
    if (d.idenfy_face_result) detail.push(`Face check: <strong>${d.idenfy_face_result}</strong>`);
    if (d.idenfy_doc_result) detail.push(`Document check: ${d.idenfy_doc_result}`);
    for (const tag of asStringList(d.idenfy_mismatch_tags)) detail.push(`Mismatch: ${tag}`);
    for (const reason of asStringList(d.idenfy_suspicion_reasons)) detail.push(`Flag: ${reason}`);

    const targets = await getVehicleNotificationTargets();
    await emailService.send('identity_review_required', {
      to: targets.to,
      cc: targets.cc,
      variables: {
        driverName: d.full_name || 'Unknown driver',
        driverEmail: d.email || 'N/A',
        jobNumber: d.current_job_number ? String(d.current_job_number) : '',
        checkDetail: detail.map(line => `• ${line}`).join('<br/>'),
        driverUrl: `${getFrontendUrl()}/drivers/${driverId}`,
      },
    });

    console.log(`[identity-review] Alert sent for driver ${d.full_name} (${driverId})`);
    return { sent: true };
  } catch (err) {
    if (!force) {
      await query(
        `UPDATE drivers SET identity_alert_sent_at = NULL WHERE id = $1`,
        [driverId],
      ).catch(() => { /* best-effort release */ });
    }
    console.error('[identity-review] Failed to send identity review alert:', err);
    return { sent: false, reason: 'send_failed' };
  }
}

/** JSONB columns arrive as arrays, strings, or null depending on the writer. */
function asStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(v => String(v)).filter(Boolean) : [value];
    } catch {
      return [value];
    }
  }
  return [];
}
