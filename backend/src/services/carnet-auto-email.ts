/**
 * Carnet request-form auto-emailer.
 *
 * Daily: sends the client request form for we-supply carnets, and chases when it
 * hasn't come back. Obeys the per-job email-routing picker (via
 * resolveClientEmailTarget with the `carnet_request` bucket) + the lost/cancelled
 * + internal-job gates.
 *
 *   Initial send  — carnet still 'detected', job confirmed, needed-by within 28 days.
 *   Chase         — form sent, not submitted, no chase yet, needed-by within 14 days.
 *
 * "Needed by" = COALESCE(carnet_start_date, out_date, job_date) — when the carnet
 * must be in hand. See docs/CARNET-SPEC.md.
 */
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';
import { emailService } from './email-service';
import { resolveClientEmailTarget } from './money-emails';
import { getFrontendUrl } from '../config/app-urls';

const INITIAL_WINDOW_DAYS = 28;
const CHASE_WINDOW_DAYS = 14;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Operational gate: confirmed-or-progressing, not lost/cancelled/internal.
const JOB_GATE = `
  COALESCE(j.is_internal, false) = false
  AND j.is_deleted = false
  AND j.pipeline_status IN ('confirmed', 'prepping', 'prepped')`;

async function logInteraction(jobId: string, content: string) {
  try {
    await query(`INSERT INTO interactions (job_id, type, content, created_by) VALUES ($1, 'note', $2, $3)`, [jobId, content, SYSTEM_USER_ID]);
  } catch (e) { console.error('[carnet-auto-email] interaction log failed:', e); }
}

interface CarnetRow { id: string; job_id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null }

// Mint the token + send the initial request form for one detected carnet.
// Used by the daily scheduler AND the on-confirmation hook.
async function sendInitialForm(c: CarnetRow): Promise<boolean> {
  const token = randomBytes(24).toString('base64url');
  await query(
    `UPDATE job_carnets SET form_token = $1, form_sent_at = NOW(), status = 'form_sent', updated_at = NOW() WHERE id = $2`,
    [token, c.id]
  );
  const url = `${getFrontendUrl()}/carnet-form/${token}`;
  const target = await resolveClientEmailTarget(c.job_id, 'carnet_request');
  if (target?.primaryEmail) {
    await emailService.send('carnet_request', {
      to: target.primaryEmail, cc: target.ccEmails,
      variables: { clientName: c.client_name || '', jobName: c.job_name || '', jobNumber: String(c.hh_job_number || ''), formUrl: url },
    });
    await logInteraction(c.job_id, `📄 Carnet request form auto-sent to ${target.primaryEmail}`);
    return true;
  }
  await logInteraction(c.job_id, '📄 Carnet request form ready but no client email on file — staff to send manually');
  return false;
}

/**
 * Send the carnet request form for a single job on confirmation, if it has a
 * we-supply carnet still 'detected' and within the initial window. Idempotent
 * (form_sent_at gate). Returns 1 if sent, 0 otherwise. Gated on lost/cancelled
 * + internal via JOB_GATE.
 */
export async function sendCarnetFormForJob(jobId: string): Promise<number> {
  const res = await query(
    `SELECT c.id, c.job_id, j.hh_job_number, j.job_name, j.client_name
     FROM job_carnets c JOIN jobs j ON j.id = c.job_id
     WHERE c.job_id = $1 AND c.mode = 'we_supply' AND c.status = 'detected' AND c.form_sent_at IS NULL
       AND ${JOB_GATE}
       AND COALESCE(c.carnet_start_date, j.out_date, j.job_date) IS NOT NULL
       AND COALESCE(c.carnet_start_date, j.out_date, j.job_date) <= CURRENT_DATE + ($2 || ' days')::interval
     LIMIT 1`,
    [jobId, INITIAL_WINDOW_DAYS]
  );
  if (res.rows.length === 0) return 0;
  try {
    await sendInitialForm(res.rows[0]);
    return 1;
  } catch (e) {
    console.error(`[carnet-auto-email] on-confirmation send failed for job ${jobId}:`, e);
    return 0;
  }
}

export async function runCarnetAutoEmails(): Promise<{ sent: number; chased: number }> {
  let sent = 0;
  let chased = 0;

  // ── Initial send ──
  const toSend = await query(
    `SELECT c.id, c.job_id, j.hh_job_number, j.job_name, j.client_name
     FROM job_carnets c JOIN jobs j ON j.id = c.job_id
     WHERE c.mode = 'we_supply' AND c.status = 'detected' AND c.form_sent_at IS NULL
       AND ${JOB_GATE}
       AND COALESCE(c.carnet_start_date, j.out_date, j.job_date) IS NOT NULL
       AND COALESCE(c.carnet_start_date, j.out_date, j.job_date) <= CURRENT_DATE + ($1 || ' days')::interval`,
    [INITIAL_WINDOW_DAYS]
  );
  for (const c of toSend.rows) {
    try {
      if (await sendInitialForm(c)) sent++;
    } catch (e) {
      console.error(`[carnet-auto-email] initial send failed for carnet ${c.id}:`, e);
    }
  }

  // ── Chase ──
  const toChase = await query(
    `SELECT c.id, c.job_id, c.form_token, j.hh_job_number, j.job_name, j.client_name
     FROM job_carnets c JOIN jobs j ON j.id = c.job_id
     WHERE c.mode = 'we_supply' AND c.status = 'form_sent'
       AND c.form_submitted_at IS NULL AND c.form_reminder_sent_at IS NULL
       AND c.form_token IS NOT NULL
       AND c.form_sent_at < NOW() - INTERVAL '3 days'
       AND ${JOB_GATE}
       AND COALESCE(c.carnet_start_date, j.out_date, j.job_date) <= CURRENT_DATE + ($1 || ' days')::interval`,
    [CHASE_WINDOW_DAYS]
  );
  for (const c of toChase.rows) {
    try {
      const target = await resolveClientEmailTarget(c.job_id, 'carnet_request');
      if (target?.primaryEmail) {
        const url = `${getFrontendUrl()}/carnet-form/${c.form_token}`;
        await emailService.send('carnet_request_chase', {
          to: target.primaryEmail, cc: target.ccEmails,
          variables: { clientName: c.client_name || '', jobName: c.job_name || '', jobNumber: String(c.hh_job_number || ''), formUrl: url },
        });
        await query(`UPDATE job_carnets SET form_reminder_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, [c.id]);
        await logInteraction(c.job_id, `📄 Carnet request form chase sent to ${target.primaryEmail}`);
        chased++;
      }
    } catch (e) {
      console.error(`[carnet-auto-email] chase failed for carnet ${c.id}:`, e);
    }
  }

  return { sent, chased };
}
