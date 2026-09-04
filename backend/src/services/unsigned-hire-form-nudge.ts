/**
 * Unsigned hire-form nudge
 *
 * A driver can re-verify every document and stop one screen short of signing
 * — the DVLA page reads "validated" before Continue is pressed, and a returning
 * driver reads that as done (Cameron Williams-Hill / job 16618, Sep 2026).
 * Until they sign, no vehicle_hire_assignments row exists and nothing joins
 * them to the hire; every OP surface used to read green because it keyed off
 * last time's signature.
 *
 * Runs hourly in business hours. For every driver `unsignedJobNumberSql()`
 * flags whose last write is over NUDGE_AFTER_HOURS old, it emails them the
 * hire-form link ONCE per (driver, hire), stamps the send on the driver row
 * FIRST (released if the send throws — same discipline as
 * referral_alert_sent_at), and logs a line on the job timeline so staff can
 * see it went.
 *
 * Deliberately NO staff bell: the greyed "started, not signed" card on Job
 * Detail and the amber cockpit action are the staff signal.
 */

import { query } from '../config/database';
import emailService from './email-service';
import { unsignedJobNumberSql } from './driver-hire-progress';
import { isWithinBusinessHours } from './completion-chaser';

/** Quiet for this long after the last form write before we chase. */
export const NUDGE_AFTER_HOURS = 2;

export interface NudgeResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: string[];
}

interface Candidate {
  id: string;
  full_name: string;
  email: string;
  current_job_number: number;
  job_id: string;
  job_name: string | null;
  job_date: string | null;
}

export async function runUnsignedHireFormNudge(now: Date = new Date()): Promise<NudgeResult> {
  const result: NudgeResult = { scanned: 0, sent: 0, skipped: 0, errors: [] };
  if (!isWithinBusinessHours(now)) return result;

  const candidates = await query(
    `SELECT d.id, d.full_name, d.email, d.current_job_number,
            j.id AS job_id, j.job_name, j.job_date
     FROM drivers d
     JOIN jobs j ON j.hh_job_number = d.current_job_number AND j.is_deleted = false
     WHERE d.is_active = true
       AND d.email IS NOT NULL AND d.email <> ''
       AND d.updated_at < NOW() - ($1 || ' hours')::interval
       AND d.unsigned_nudge_job_number IS DISTINCT FROM d.current_job_number
       AND ${unsignedJobNumberSql('d')} IS NOT NULL`,
    [String(NUDGE_AFTER_HOURS)]
  );
  result.scanned = candidates.rows.length;

  for (const c of candidates.rows as Candidate[]) {
    // Claim first — a concurrent run or a retry must not double-send.
    const claim = await query(
      `UPDATE drivers
       SET unsigned_nudge_job_number = current_job_number, unsigned_nudge_sent_at = NOW()
       WHERE id = $1 AND unsigned_nudge_job_number IS DISTINCT FROM current_job_number`,
      [c.id]
    );
    if (claim.rowCount === 0) { result.skipped++; continue; }

    const jobDate = c.job_date ? new Date(c.job_date) : null;
    const startDate = jobDate
      ? jobDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    const firstName = (c.full_name || '')
      .replace(/^(MR|MRS|MS|MISS|DR|PROF)\s+/i, '')
      .split(' ')[0] || 'there';

    try {
      await emailService.send('hire_form_unsigned_nudge', {
        to: c.email,
        variables: {
          driverName: firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase(),
          jobNumber: String(c.current_job_number),
          jobName: c.job_name || '',
          startDate,
          hireFormUrl: `https://hireforms.oooshtours.co.uk/?job=${c.current_job_number}`,
        },
      });
      result.sent++;

      await query(
        `INSERT INTO interactions (type, content, job_id, source)
         VALUES ('email', $1, $2, 'system')`,
        [
          `Nudged ${c.full_name} (${c.email}) — started the hire form for #${c.current_job_number} but hasn't signed it. Reminder email sent with the form link.`,
          c.job_id,
        ]
      ).catch(err => console.error('[unsigned-nudge] timeline log failed:', err));
    } catch (err) {
      // Release the claim so the next run can try again.
      await query(
        `UPDATE drivers SET unsigned_nudge_job_number = NULL, unsigned_nudge_sent_at = NULL WHERE id = $1`,
        [c.id]
      ).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${c.email} / #${c.current_job_number}: ${msg}`);
      console.error(`[unsigned-nudge] send failed for ${c.email} (#${c.current_job_number}):`, msg);
    }
  }

  return result;
}
