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
 * Overall verdicts that mean iDenfy did NOT accept the check.
 *
 * `EXPIRED` is deliberately absent and must stay that way. It is not a verdict:
 * iDenfy fires it when "the user never completes the verification and the token
 * reaches its tokenExpiry or the session exceeds sessionLength" — i.e. the
 * driver opened the link and wandered off. Treating an abandoned tab as a
 * failed check would flag innocent drivers several times a week and the flag
 * would stop being believed. What an EXPIRED session must never do is leave
 * EVIDENCE behind; that is handled in the hire-form app, which no longer writes
 * a check date or any licence field for one.
 */
const REVIEWABLE_OVERALL = new Set(['DENIED', 'SUSPECTED']);

/**
 * Does this iDenfy result need a human before the driver goes any further?
 *
 * WHY THIS REPLACED THE FACE-ONLY TEST
 * ------------------------------------
 * faceNeedsReview() below was written for the Aug 2026 face-match work and does
 * its job exactly as specified — but it only ever looked at ONE of the three
 * answers iDenfy gives us. The overall verdict and the document verdict were
 * persisted and then read by nothing except the alert email, so iDenfy could
 * reject a licence outright and OP would wave the driver through:
 *
 *   Jo Walker / 16249    DENIED · DOC_SPOOF_DETECTED · face FACE_MATCH
 *   Simon Halliday/15551 DENIED · DOC_SIDE_MISMATCH  · face FACE_MATCH
 *
 * In both, the face matched perfectly and the DOCUMENT was the problem, so the
 * face test was never going to catch either. `overall` is the field to key on
 * because it is independent of iDenfy's tag vocabulary — a spoof might be
 * reported in fraudTags, mismatchTags or autoDocument depending on their schema
 * version, but a rejection is always DENIED.
 *
 * A mismatch is usually innocent (a bad capture, glare on the laminate, an
 * older licence photo) — this is "someone must look", not "rejected".
 */
export function idenfyNeedsReview(verdict: {
  overall?: string | null;
  faceResult?: string | null;
}): boolean {
  const overall = (verdict.overall || '').toUpperCase().trim();
  if (REVIEWABLE_OVERALL.has(overall)) return true;
  return faceNeedsReview(verdict.faceResult);
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

// ── A staff decision on a photo ID check (Nov 2026) ─────────────────────────
//
// Katje / job 16831: iDenfy couldn't read her paper licence, staff rejected it,
// she re-sent photos, Matt typed her licence details in — and she stayed
// "ID Rejected", because the panel only offered a decision while one was
// waiting. And her name stayed her email address, because nothing asked.
//
// So accepting asks for what the webhook would have written had iDenfy read the
// document, and refuses until the identity is complete. The check date is
// ASKED, never assumed: the rule that one click must not mint a validity window
// still stands — a person types the day they checked the documents.

/** What the webhook fills in from a licence iDenfy could read. */
export const IDENTITY_DETAIL_FIELDS = [
  'full_name', 'date_of_birth', 'nationality',
  'licence_number', 'licence_issued_by', 'licence_issue_country',
  'licence_valid_from', 'licence_valid_to', 'licence_address',
  'idenfy_check_date',
] as const;
export type IdentityDetailField = (typeof IDENTITY_DETAIL_FIELDS)[number];

/** Without these the record isn't an identity: who, born when, which licence, checked when. */
export const REQUIRED_IDENTITY_FIELDS: readonly IdentityDetailField[] = [
  'full_name', 'date_of_birth', 'licence_number', 'licence_issued_by',
  'licence_issue_country', 'idenfy_check_date',
];

const IDENTITY_FIELD_LABELS: Record<IdentityDetailField, string> = {
  full_name: 'full name',
  date_of_birth: 'date of birth',
  nationality: 'nationality',
  licence_number: 'licence number',
  licence_issued_by: 'issued by',
  licence_issue_country: 'country of issue',
  licence_valid_from: 'valid from',
  licence_valid_to: 'licence expiry',
  licence_address: 'licence address',
  idenfy_check_date: 'date you checked the documents',
};

const DATE_FIELDS = new Set<IdentityDetailField>([
  'date_of_birth', 'licence_valid_from', 'licence_valid_to', 'idenfy_check_date',
]);

/** Age limits the webhook applies (insurer's): under 23 is blocked, over 75 refers. */
export const MIN_DRIVER_AGE = 23;
export const REFER_OVER_AGE = 75;

export type IdentityDetails = Partial<Record<IdentityDetailField, string>> & { full_licence?: boolean };

export type IdentityDecisionPlan =
  | { ok: false; status: number; error: string }
  | { ok: true; set: Record<string, unknown>; raisedReferral: string | null };

/** A DATE column (node-postgres gives a local-midnight Date) or string, as YYYY-MM-DD. */
function ymdOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  // A real calendar date — 1976-13-45 has the right shape and isn't one.
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : null;
}

/** Whole years between two YYYY-MM-DD dates. */
export function ageOn(dob: string, today: string): number {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * Work out what a staff decision writes, or why it can't be made. Pure: the
 * route reads the driver, asks this, then writes `set` in one transaction.
 *
 *  - Reversing a REJECTION is manager-tier; any change of decision needs a reason.
 *  - Accepting needs a complete identity (the record's values, overlaid with
 *    what was typed). A name that is still the email address doesn't count.
 *  - The webhook's age rules: under 23 is refused; over 75 raises a referral
 *    (raise only — an approved or waived one is left alone).
 */
export function planIdentityDecision(input: {
  current: Record<string, unknown>;
  outcome: 'accepted' | 'rejected';
  notes: string;
  details?: IdentityDetails;
  isManager: boolean;
  today: string;
}): IdentityDecisionPlan {
  const { current, outcome, isManager, today } = input;
  const notes = (input.notes || '').trim();
  const was = (current.identity_check_status as string | null) ?? null;
  const decided = was === 'accepted' || was === 'rejected';

  if (was === 'rejected' && outcome === 'accepted' && !isManager) {
    return { ok: false, status: 403, error: 'Only a manager can reverse a rejected ID check.' };
  }
  if (decided && was !== outcome && !notes) {
    return { ok: false, status: 400, error: 'Say why the decision is changing.' };
  }
  if (outcome === 'rejected') return { ok: true, set: {}, raisedReferral: null };

  const details = input.details || {};
  const set: Record<string, unknown> = {};
  for (const field of IDENTITY_DETAIL_FIELDS) {
    const raw = details[field];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    set[field] = raw.trim();
  }
  if (details.full_licence === true) set.licence_type = 'full';

  // Dates typed must be real dates; the check can't be in the future.
  for (const field of IDENTITY_DETAIL_FIELDS) {
    if (!DATE_FIELDS.has(field) || !(field in set)) continue;
    if (!ymdOf(set[field])) {
      return { ok: false, status: 400, error: `The ${IDENTITY_FIELD_LABELS[field]} isn't a date.` };
    }
  }
  if (set.idenfy_check_date && String(set.idenfy_check_date) > today) {
    return { ok: false, status: 400, error: 'The date you checked the documents can’t be in the future.' };
  }

  const merged: Record<string, unknown> = { ...current, ...set };
  const missing = REQUIRED_IDENTITY_FIELDS.filter((f) => !hasValue(merged[f]));
  if (hasValue(merged.full_name) && String(merged.full_name).includes('@') && !missing.includes('full_name')) {
    missing.unshift('full_name');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Fill in the ${missing.map((f) => IDENTITY_FIELD_LABELS[f]).join(', ')} before accepting.`,
    };
  }
  if (String(merged.licence_type || '').toLowerCase().match(/provisional|learner/)) {
    return { ok: false, status: 400, error: 'A provisional or learner licence can’t be accepted.' };
  }

  const dob = ymdOf(merged.date_of_birth);
  if (!dob || dob >= today) {
    return { ok: false, status: 400, error: 'The date of birth isn’t right.' };
  }
  const age = ageOn(dob, today);
  if (age < MIN_DRIVER_AGE) {
    return { ok: false, status: 400, error: `The driver is ${age} — we can’t insure drivers under ${MIN_DRIVER_AGE}.` };
  }

  let raisedReferral: string | null = null;
  const referralSettled = current.referral_status === 'approved' || current.referral_status === 'waived';
  if (age > REFER_OVER_AGE && current.requires_referral !== true && !referralSettled) {
    raisedReferral = `Driver is ${age} years old (over ${REFER_OVER_AGE})`;
    set.requires_referral = true;
    set.referral_notes = [current.referral_notes, raisedReferral].filter(hasValue).join(' | ');
  }

  return { ok: true, set, raisedReferral };
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

    const targets = await getVehicleNotificationTargets();
    await emailService.send('identity_review_required', {
      to: targets.to,
      cc: targets.cc,
      variables: {
        // No name when iDenfy couldn't read the document (Steve Claes, 16831).
        driverName: d.full_name || 'Name not read from the document',
        driverEmail: d.email || 'N/A',
        jobNumber: d.current_job_number ? String(d.current_job_number) : '',
        headline: identityAlertHeadline(d.idenfy_face_result, d.idenfy_doc_result),
        checkDetail: identityAlertDetail(d),
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

/**
 * The alert's opening line, from what actually failed. It used to say "could
 * not match this driver's selfie" every time — wrong for most reviews since the
 * Sep 2026 widening, which catch a rejected DOCUMENT with a perfect face match.
 */
export function identityAlertHeadline(
  faceResult: string | null | undefined,
  docResult: string | null | undefined,
): string {
  if (faceNeedsReview(faceResult)) {
    return 'iDenfy could not match this driver’s selfie to the photo on their licence.';
  }
  if ((docResult || '').toUpperCase().trim() === 'DOC_NOT_SUPPORTED') {
    return 'iDenfy did not recognise the document this driver used — usually an old paper licence it cannot read.';
  }
  return 'iDenfy did not accept this driver’s photo ID check.';
}

/**
 * What iDenfy reported, one PLAIN-TEXT line each. The email escapes every
 * variable, so HTML in here printed as literal `<strong>` / `<br/>` (Nov 2026);
 * the template shows the lines with `white-space: pre-line` instead.
 */
export function identityAlertDetail(d: {
  idenfy_overall?: string | null;
  idenfy_face_result?: string | null;
  idenfy_doc_result?: string | null;
  idenfy_mismatch_tags?: unknown;
  idenfy_suspicion_reasons?: unknown;
}): string {
  const detail: string[] = [];
  if (d.idenfy_overall) detail.push(`iDenfy result: ${d.idenfy_overall}`);
  if (d.idenfy_face_result) detail.push(`Face check: ${d.idenfy_face_result}`);
  if (d.idenfy_doc_result) detail.push(`Document check: ${d.idenfy_doc_result}`);
  for (const tag of asStringList(d.idenfy_mismatch_tags)) detail.push(`Mismatch: ${tag}`);
  for (const reason of asStringList(d.idenfy_suspicion_reasons)) detail.push(`Flag: ${reason}`);
  return detail.map(line => `• ${line}`).join('\n');
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
