/**
 * Unsigned hire-form nudge
 *
 * A driver can start a hire form and go quiet at any point in it. Until they
 * SIGN, no `vehicle_hire_assignments` row exists and nothing joins them to the
 * hire — every OP surface used to read green because it keyed off last time's
 * signature (Cameron Williams-Hill / job 16618, Sep 2026).
 *
 * WHY THERE ARE TWO EMAILS
 * ------------------------
 * The trigger (`unsignedJobNumberSql()`) answers exactly one question: "is this
 * driver joined to the hire yet?" It says nothing about their paperwork. Built
 * for Cameron — whose documents WERE all valid and who closed the tab one
 * screen short of signing — it shipped with a single email whose copy said
 * "your documents have all been checked and are fine, there's just one thing
 * left". For every other shape of stuck driver that was simply untrue: a driver
 * who got as far as the OTP and stopped was told their documents were fine when
 * they had never been uploaded.
 *
 * So the trigger is unchanged and the COPY is chosen from how far they actually
 * got, using `hasAllRequiredDocuments()` — the same rule the driver's own form
 * routes on, so the email and the form they land in cannot disagree:
 *
 *   ready_to_sign — everything verified, only the signature is left
 *   incomplete    — documents still outstanding, here is what they are
 *
 * ONE OF EACH KIND, PER HIRE
 * --------------------------
 * The dedup stamp is (job number, stage), not job number alone (migration 201).
 * Keyed on the job alone, a driver nudged while incomplete who then finished
 * their documents and stopped at the signature screen would never be chased —
 * losing the exact case the nudge was built for. Keyed on both, they get at
 * most one of each kind. The stage only ever moves forwards: once
 * `ready_to_sign` has gone out for a hire the driver leaves the scan for good,
 * so a document lapsing later can't start a chase ping-pong. That is a staff
 * matter by then, and the driver page shows it.
 *
 * Drivers held in identity review are skipped entirely and never stamped: their
 * own form shows the terminal "we're checking this by hand, you don't need to
 * do anything" screen, and `allValid` can still be TRUE for them (the licence
 * window is valid; it was the face match that failed). Chasing them would ask
 * for something the form refuses to let them do. If staff clear the review they
 * become nudgeable again.
 *
 * Runs hourly in business hours. Stamps the send on the driver row FIRST
 * (restored if the send throws — same discipline as referral_alert_sent_at) and
 * logs a line on the job timeline so staff can see it went.
 *
 * Deliberately NO staff bell: the greyed "started, not signed" card on Job
 * Detail and the amber cockpit action are the staff signal.
 */

import { query } from '../config/database';
import emailService from './email-service';
import { unsignedJobNumberSql } from './driver-hire-progress';
import { isWithinBusinessHours } from './completion-chaser';
import { computeDriverValidity, outstandingDocuments, hasAllRequiredDocuments } from './driver-validity';
import { isIdentityAuthorised } from './identity-review';

/** Quiet for this long after the last form write before we chase. */
export const NUDGE_AFTER_HOURS = 2;

/** Which kind of nudge a driver is due. Only ever moves forwards. */
export type NudgeStage = 'incomplete' | 'ready_to_sign';

export interface NudgeResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: string[];
}

/** The driver row (`d.*`) plus the job it was started for. */
type Candidate = Record<string, unknown> & {
  id: string;
  full_name: string;
  email: string;
  current_job_number: number;
  unsigned_nudge_job_number: number | null;
  unsigned_nudge_stage: string | null;
  unsigned_nudge_sent_at: Date | null;
  job_id: string;
  job_name: string | null;
  job_date: string | null;
};

export async function runUnsignedHireFormNudge(now: Date = new Date()): Promise<NudgeResult> {
  const result: NudgeResult = { scanned: 0, sent: 0, skipped: 0, errors: [] };
  if (!isWithinBusinessHours(now)) return result;

  // `d.*` because the stage decision runs the full validity engine over the row.
  // The stamp predicate is the "forwards only" rule: never seen for this hire,
  // or seen only at the incomplete stage (so a ready_to_sign chase can follow).
  const candidates = await query(
    `SELECT d.*, j.id AS job_id, j.job_name, j.job_date
     FROM drivers d
     JOIN jobs j ON j.hh_job_number = d.current_job_number AND j.is_deleted = false
     WHERE d.is_active = true
       AND d.email IS NOT NULL AND d.email <> ''
       AND d.updated_at < NOW() - ($1 || ' hours')::interval
       AND (d.unsigned_nudge_job_number IS DISTINCT FROM d.current_job_number
            OR d.unsigned_nudge_stage = 'incomplete')
       AND ${unsignedJobNumberSql('d')} IS NOT NULL`,
    [String(NUDGE_AFTER_HOURS)]
  );
  result.scanned = candidates.rows.length;

  for (const c of candidates.rows as Candidate[]) {
    // Held for a human — their form is a dead end, so an email asking them to
    // continue would be asking for the impossible. No stamp: if staff clear the
    // review, the next run picks them up.
    if (!isIdentityAuthorised((c.identity_check_status as string | null) ?? null)) {
      result.skipped++;
      continue;
    }

    const validity = computeDriverValidity(c as never);
    const outstanding = outstandingDocuments(validity);
    const stage: NudgeStage = hasAllRequiredDocuments(validity) ? 'ready_to_sign' : 'incomplete';

    // Claim first — a concurrent run or a retry must not double-send.
    const claim = await query(
      `UPDATE drivers
       SET unsigned_nudge_job_number = current_job_number,
           unsigned_nudge_stage = $2,
           unsigned_nudge_sent_at = NOW()
       WHERE id = $1
         AND (unsigned_nudge_job_number IS DISTINCT FROM current_job_number
              OR unsigned_nudge_stage IS DISTINCT FROM $2)`,
      [c.id, stage]
    );
    if (claim.rowCount === 0) { result.skipped++; continue; }

    const jobDate = c.job_date ? new Date(c.job_date) : null;
    const startDate = jobDate
      ? jobDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    const firstName = (c.full_name || '')
      .replace(/^(MR|MRS|MS|MISS|DR|PROF)\s+/i, '')
      .split(' ')[0] || 'there';

    const variables: Record<string, string> = {
      driverName: firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase(),
      jobNumber: String(c.current_job_number),
      jobName: c.job_name || '',
      startDate,
      hireFormUrl: `https://hireforms.oooshtours.co.uk/?job=${c.current_job_number}`,
    };
    if (stage === 'incomplete') {
      // Flags, not a pre-built list: template variables are HTML-escaped, so the
      // items have to be {{#if}} blocks inside the template itself.
      if (outstanding.licence) variables.needLicence = '1';
      if (outstanding.poa1) variables.needPoa1 = '1';
      if (outstanding.poa2) variables.needPoa2 = '1';
      if (outstanding.dvla) variables.needDvla = '1';
      if (outstanding.passport) variables.needPassport = '1';
    }

    try {
      await emailService.send(
        stage === 'ready_to_sign' ? 'hire_form_unsigned_nudge' : 'hire_form_incomplete_nudge',
        { to: c.email, variables }
      );
      result.sent++;

      const outstandingList = Object.entries(outstanding)
        .filter(([, missing]) => missing)
        .map(([key]) => OUTSTANDING_LABEL[key] || key)
        .join(', ');
      await query(
        `INSERT INTO interactions (type, content, job_id, source)
         VALUES ('email', $1, $2, 'system')`,
        [
          stage === 'ready_to_sign'
            ? `Nudged ${c.full_name} (${c.email}) — started the hire form for #${c.current_job_number} but hasn't signed it. Reminder email sent with the form link.`
            : `Nudged ${c.full_name} (${c.email}) — hire form for #${c.current_job_number} started but not finished (still needed: ${outstandingList}). Reminder email sent with the form link.`,
          c.job_id,
        ]
      ).catch(err => console.error('[unsigned-nudge] timeline log failed:', err));
    } catch (err) {
      // Restore the stamp as it was so the next run can try again — NOT to
      // NULL, which would forget an earlier incomplete nudge and re-send it.
      await query(
        `UPDATE drivers
         SET unsigned_nudge_job_number = $2, unsigned_nudge_stage = $3, unsigned_nudge_sent_at = $4
         WHERE id = $1`,
        [c.id, c.unsigned_nudge_job_number, c.unsigned_nudge_stage, c.unsigned_nudge_sent_at]
      ).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${c.email} / #${c.current_job_number}: ${msg}`);
      console.error(`[unsigned-nudge] send failed for ${c.email} (#${c.current_job_number}):`, msg);
    }
  }

  return result;
}

/** Staff-facing names for the outstanding documents, for the timeline line. */
const OUTSTANDING_LABEL: Record<string, string> = {
  licence: 'licence check',
  poa1: 'proof of address 1',
  poa2: 'proof of address 2',
  dvla: 'DVLA check',
  passport: 'passport',
};
