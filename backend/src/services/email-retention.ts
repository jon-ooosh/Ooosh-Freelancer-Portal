/**
 * Ingested-email retention sweep (Auto-Chase Phase 1, spec §5.6)
 *
 * Strips the verbatim body from `type='email'` interactions once they pass the
 * retention window (default 24 months), keeping metadata + snippet so the
 * timeline still shows a conversation happened and dedup/audit still work. This
 * discharges the GDPR data-minimisation duty on the bulk PII (the full body)
 * without leaving holes in the history.
 *
 * Window is a system_settings value (email_retention_months, default 24) so
 * it's tunable without a deploy. Idempotent: body_stripped_at gates re-runs.
 * Attachments harvested to jobs.files are NOT touched — they're operational
 * documents under the file-retention policy, not conversational PII.
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';

export interface RetentionSweepSummary {
  windowMonths: number;
  stripped: number;
}

const STRIP_PLACEHOLDER = '[Email body removed under retention policy — metadata retained]';

export async function runEmailRetentionSweep(): Promise<RetentionSweepSummary> {
  const raw = await getSystemSetting('email_retention_months');
  const parsed = parseInt(raw || '', 10);
  const windowMonths = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;

  const result = await query(
    `UPDATE interactions
        SET content = $1,
            body_stripped_at = NOW()
      WHERE type = 'email'
        AND gmail_message_id IS NOT NULL
        AND body_stripped_at IS NULL
        AND created_at < NOW() - ($2 || ' months')::interval
      RETURNING id`,
    [STRIP_PLACEHOLDER, String(windowMonths)],
  );

  return { windowMonths, stripped: result.rows.length };
}
