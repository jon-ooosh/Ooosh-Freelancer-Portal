/**
 * Auto-chase runner (Auto-Chase Phase 2/3, spec §9–§10)
 *
 * The scheduled engine that turns the per-job `auto_chase_mode` dial into action.
 * Daily, it finds jobs whose chase has come due AND are opted into auto-chase,
 * runs the suppression checklist (§10), and — if clear — creates a Gmail draft
 * (draft mode) or sends it (send mode, gated behind the master switch).
 *
 * Safety model (deliberately conservative):
 *  - `auto_chase_mode` is per-job (Off / Draft / Auto-send), set on the ChaseModal.
 *  - Even a job set to 'send' only actually SENDS when the global master switch
 *    `auto_chase_send_enabled` is 'true'. Until then a 'send' job just gets a
 *    draft — so staff can watch what WOULD go out before enabling real sends.
 *  - Every automated chase passes the suppression gate first; a cold dead-end
 *    (N silent chases) escalates to a human and turns the job's auto-chase OFF.
 *
 * Chase-date maths reuses the existing model: after a chase we push
 * next_chase_date forward by chase_interval_days so the cadence continues; an
 * inbound client reply (ingested) bumps the date + resets the silent counter
 * for free (see gmail-ingestion.ts), which is what makes the loop self-unenrol.
 */
import { query } from '../config/database';
import { isGmailConfigured } from '../config/gmail';
import { isAnthropicConfigured } from '../config/anthropic';
import { getSystemSetting } from '../routes/system-settings';
import { evaluateChaseSuppression } from './chase-suppression';
import { createChaseDraftForJob } from './gmail-draft';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface AutoChaseRunSummary {
  configured: boolean;
  due: number;
  drafted: number;
  sent: number;
  suppressed: number;
  escalated: number;
  failed: number;
  sendMasterOn: boolean;
}

/** Log a system-authored chase interaction on the job timeline (audit trail). */
async function logChaseInteraction(jobId: string, content: string): Promise<void> {
  await query(
    `INSERT INTO interactions (type, content, job_id, created_by, source)
     VALUES ('chase', $1, $2, $3, 'system')`,
    [content, jobId, SYSTEM_USER_ID],
  );
}

/** Push a job's chase date forward + bump the silent counter after an auto-chase. */
async function advanceAfterChase(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET
       auto_chase_count = COALESCE(auto_chase_count, 0) + 1,
       last_auto_chase_at = NOW(),
       last_chased_at = NOW(),
       next_chase_date = (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date,
       updated_at = NOW()
     WHERE id = $1`,
    [jobId],
  );
}

/** Suppressed (soft) — hold the chase for one interval so we don't re-check daily. */
async function deferChase(jobId: string): Promise<void> {
  await query(
    `UPDATE jobs SET
       next_chase_date = (CURRENT_DATE + (COALESCE(chase_interval_days, 5) || ' days')::interval)::date,
       updated_at = NOW()
     WHERE id = $1`,
    [jobId],
  );
}

/** Cold dead-end: turn auto-chase off + notify a human to take over. */
async function escalate(job: { id: string; hh_job_number: number | null; job_name: string | null; chase_alert_user_id: string | null }, reason: string): Promise<void> {
  // Stop the automated cadence.
  await query(`UPDATE jobs SET auto_chase_mode = 'off', updated_at = NOW() WHERE id = $1`, [job.id]);

  const label = job.job_name || `Job ${job.hh_job_number || ''}`.trim();
  // Notify the job's chase-alert owner if set, else all active admins/managers.
  const recipients = job.chase_alert_user_id
    ? [{ id: job.chase_alert_user_id }]
    : (await query(`SELECT id FROM users WHERE role IN ('admin','manager') AND is_active = true`)).rows;

  for (const r of recipients) {
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
         VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4, $5, 'normal')`,
        [
          r.id,
          `Auto-chase stopped: ${label}`,
          `${reason}. Auto-chase has been switched off for this job — please call them or mark it lost.`,
          job.id,
          `/jobs/${job.id}?tab=timeline`,
        ],
      );
    } catch {
      /* non-critical */
    }
  }
  await logChaseInteraction(job.id, `🛑 Auto-chase stopped — ${reason}. Handed to a human.`);
}

/**
 * Process all jobs whose auto-chase is due. Safe to call daily. No-ops cleanly
 * when Gmail / Anthropic aren't configured.
 */
export async function runDueAutoChases(): Promise<AutoChaseRunSummary> {
  const summary: AutoChaseRunSummary = {
    configured: isGmailConfigured() && isAnthropicConfigured(),
    due: 0, drafted: 0, sent: 0, suppressed: 0, escalated: 0, failed: 0, sendMasterOn: false,
  };
  if (!summary.configured) return summary;

  summary.sendMasterOn = (await getSystemSetting('auto_chase_send_enabled')) === 'true';
  // Fallback sign-off name for automated chases (no clicker). Per-job manager
  // wins; this is the catch-all before "the Ooosh team".
  const defaultSender = ((await getSystemSetting('chase_default_sender_name')) || '').trim() || null;

  const due = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.auto_chase_mode, j.chase_alert_user_id,
            sp.first_name AS setter_first_name,
            mp.first_name AS manager_first_name
       FROM jobs j
       LEFT JOIN users su ON su.id = j.auto_chase_set_by
       LEFT JOIN people sp ON sp.id = su.person_id
       LEFT JOIN people mp ON mp.id = j.manager1_person_id
      WHERE j.is_deleted = false
        AND COALESCE(j.is_internal, false) = false
        AND j.auto_chase_mode IN ('draft','send')
        AND j.next_chase_date IS NOT NULL
        AND j.next_chase_date <= CURRENT_DATE
        AND j.pipeline_status IN ('new_enquiry','quoting','paused','provisional')
      ORDER BY j.next_chase_date ASC
      LIMIT 100`,
  );
  summary.due = due.rows.length;

  for (const job of due.rows) {
    try {
      const sup = await evaluateChaseSuppression(job.id);

      if (sup.escalate) {
        await escalate(job, sup.reason);
        summary.escalated++;
        continue;
      }
      if (!sup.proceed) {
        await deferChase(job.id);
        await logChaseInteraction(job.id, `⏸ Auto-chase held — ${sup.reason}.`);
        summary.suppressed++;
        continue;
      }

      const wantSend = job.auto_chase_mode === 'send' && summary.sendMasterOn;
      // Sign off with whoever set the auto-chase (same as a manual draft), else
      // the job's manager, else the configured default, else "the Ooosh team".
      const signOffName =
        (job.setter_first_name as string | null) ||
        (job.manager_first_name as string | null) ||
        defaultSender;
      const result = await createChaseDraftForJob(job.id, signOffName, { send: wantSend });
      await advanceAfterChase(job.id);

      if (result.sent) {
        summary.sent++;
        await logChaseInteraction(job.id, `📧 Auto-chase sent to ${result.to} — "${result.subject}".`);
      } else {
        summary.drafted++;
        const note = job.auto_chase_mode === 'send' && !summary.sendMasterOn
          ? ' (auto-send is globally off — created as a draft for review)'
          : '';
        await logChaseInteraction(job.id, `✉️ Auto-chase draft created in info@ for ${result.to}${note} — "${result.subject}".`);
      }
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auto-chase-runner] job ${job.hh_job_number || job.id} failed:`, err);
      // Push the chase out so a persistent failure (e.g. no client email on
      // file, a Gmail/Anthropic blip) doesn't re-fire every single day. Logged
      // so staff can see why nothing went out.
      try {
        await deferChase(job.id);
        await logChaseInteraction(job.id, `⚠️ Auto-chase couldn't be created — ${msg}. Held for now.`);
      } catch {
        /* best-effort */
      }
    }
  }

  return summary;
}
