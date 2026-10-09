/**
 * Rehearsal info-pack auto-send (Rehearsals item B).
 *
 * Daily: send the client info pack for confirmed rehearsal jobs whose first
 * session lands within N days and that haven't had a pack sent yet. Mirrors the
 * hire-form / carnet auto-email pattern. Off by default; enabled + N-days are set
 * from the Rehearsals hub → Info Pack tab (system_settings, category 'rehearsals').
 */
import { query } from '../config/database';
import { getSystemSettings } from '../routes/system-settings';
import { sendInfoPack } from './rehearsal-details';

export async function runRehearsalInfoPackAutoSend(): Promise<{ sent: number }> {
  const settings = await getSystemSettings([
    'rehearsal_info_pack_auto_enabled',
    'rehearsal_info_pack_auto_days',
  ]);
  if ((settings.rehearsal_info_pack_auto_enabled || '').toLowerCase() !== 'true') return { sent: 0 };
  const days = Math.max(0, parseInt(settings.rehearsal_info_pack_auto_days || '7', 10) || 7);

  // Confirmed rehearsal jobs whose first session lands within `days` and haven't
  // had an info pack sent. Self-healing window — info_pack_sent_at gates re-send.
  // Skips lost / cancelled / internal / speculative (enquiry/quoting/paused/provisional).
  const res = await query(
    `SELECT j.id
     FROM jobs j
     LEFT JOIN rehearsal_job_details rjd ON rjd.job_id = j.id
     WHERE j.is_deleted = false
       AND COALESCE(j.is_internal, false) = false
       AND j.pipeline_status NOT IN ('lost','cancelled','new_enquiry','quoting','paused','provisional')
       AND (j.hh_derived_flags->'rehearsal_detail') IS NOT NULL
       AND rjd.info_pack_sent_at IS NULL
       AND COALESCE(
             (j.hh_derived_flags->'rehearsal_detail'->>'first_session_date')::date,
             j.job_date::date
           ) BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($1 || ' days')::interval)::date`,
    [String(days)]
  );

  let sent = 0;
  for (const row of res.rows) {
    try {
      await sendInfoPack(row.id, null);
      sent++;
    } catch (e) {
      console.error(`[rehearsal-info-pack-auto] send failed for job ${row.id}:`, e);
    }
  }
  if (sent) console.log(`[rehearsal-info-pack-auto] sent ${sent} info pack(s)`);
  return { sent };
}
