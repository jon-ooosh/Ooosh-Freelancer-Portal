/**
 * Possible-claim client chase (docs/INCIDENT-CLAIMS-SPEC.md §9.1, decision D9).
 *
 * Built the house way — a marker column + a scheduled job, like pcn-chase.ts.
 * Daily (weekends too — tours run through them) for every case with the form
 * out and chasing not paused:
 *
 *   chase_level 0–3  → email every live link (sent / opened) a reminder with
 *                      the same link and "N of 8 parts done"; level + 1
 *   chase_level 4    → four reminders and still no form: stop, flag it —
 *                      `chase_escalated` event, bell the owner + watchers,
 *                      Needs Attention ("Client forms not coming back");
 *                      level 5 marks it as flagged
 *
 * A day is skipped (not counted) when the form went out, or the client did
 * something on it, in the last 20 hours — someone half-way through doesn't
 * need a "please finish" email. Stamp-first on chase_sent_for (the UK date)
 * so a re-run the same day can't double-send. Submitting ends it (the case
 * leaves form_out). Staff can pause (reason required) and restart (back to
 * reminder 1) on the case page.
 *
 * Emails never carry personal or injury details (spec §15) — just the van,
 * the job number, progress and the link.
 */
import { query } from '../config/database';
import { frontendLink } from '../config/app-urls';
import { CLAIM_SECTIONS, CLIENT_CHECKLIST, sectionMissing } from './claim-form-fields';
import { logClaimEvent, notifyClaimFollowers, claimLabel, ukDatePlus } from './incident-claims';

export const CHASE_MAX = 4;
/** chase_level once the chase has run out and been flagged to staff. */
export const CHASE_ESCALATED = CHASE_MAX + 1;
const QUIET_HOURS = 20;

/** Events that mean the client is working on the form through their link. */
const CLIENT_EVENTS = [
  'link_opened', 'who_filling', 'section_saved', 'damage_marked', 'sketch_saved',
  'driver_verified', 'driver_signed', 'handed_off', 'sent_to_driver',
];

/** How far the client form has got — the same count the form and the case page show. */
export function formProgress(c: {
  form_data: Record<string, unknown> | null;
  sections_done: Record<string, unknown> | null;
  driver_signed_at: unknown;
}): { done: number; total: number } {
  const form = c.form_data || {};
  const done = c.sections_done || {};
  let n = 0;
  for (const item of CLIENT_CHECKLIST) {
    if (item.key === 'driver') { if (c.driver_signed_at) n++; continue; }
    if (!done[item.key]) continue;
    const def = CLAIM_SECTIONS.find((s) => s.key === item.key);
    if (!def || sectionMissing(def, form).length === 0) n++;
  }
  return { done: n, total: CLIENT_CHECKLIST.length };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

async function sendChaseEmail(opts: {
  token: string; email: string; name: string | null; reg: string; hh: number | null;
  progress: { done: number; total: number }; level: number;
}): Promise<boolean> {
  const { emailService } = await import('./email-service');
  const hi = opts.name?.trim() ? opts.name.trim().split(/\s+/)[0] : 'there';
  const job = opts.hh ? ` (#${opts.hh})` : '';
  const progressLine = opts.progress.done === 0
    ? "It hasn't been started yet."
    : `You've completed ${opts.progress.done} of ${opts.progress.total} parts — please finish the rest.`;
  const last = opts.level >= CHASE_MAX;
  const result = await emailService.sendRaw({
    to: opts.email,
    subject: `Reminder: incident report — ${opts.reg}${job}`,
    variant: 'client',
    html: `
      <p>Hi ${escapeHtml(hi)},</p>
      <p>A reminder about our incident form for the van <strong>${escapeHtml(opts.reg)}</strong>${opts.hh ? ` (job #${opts.hh})` : ''}.
      ${progressLine}</p>
      <p style="margin: 24px 0;">
        <a href="${frontendLink(`/claim/${opts.token}`)}" style="background:#7B5EA7;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Open the incident form</a>
      </p>
      <p>It picks up where you left off. If someone else is better placed to answer, you can pass it on from the form.</p>
      ${last ? "<p>This is our last reminder by email — if it's easier, give us a call and we'll go through it with you.</p>" : ''}
      <p>Thanks,<br>Ooosh! Tours</p>`,
  });
  if (!result.success) console.error(`[claim-chase] reminder to ${opts.email} failed:`, result.error);
  return result.success;
}

export async function runClaimClientChase(): Promise<{ chased: number; skipped: number; escalated: number }> {
  const today = ukDatePlus(0);
  const out = { chased: 0, skipped: 0, escalated: 0 };

  // Stamp first: one run per case per day, whatever happens below.
  const due = await query(
    `UPDATE incident_claims
        SET chase_sent_for = $1
      WHERE is_deleted = false
        AND stage = 'form_out'
        AND chase_paused_at IS NULL
        AND chase_level < $2
        AND chase_sent_for IS DISTINCT FROM $1
      RETURNING id, chase_level, vehicle_reg, hh_job_number, form_data, sections_done, driver_signed_at`,
    [today, CHASE_ESCALATED],
  );

  for (const c of due.rows) {
    try {
      if (c.chase_level >= CHASE_MAX) {
        await query(`UPDATE incident_claims SET chase_level = $2, updated_at = NOW() WHERE id = $1`, [c.id, CHASE_ESCALATED]);
        await logClaimEvent(c.id, null, 'chase_escalated',
          `No form after ${CHASE_MAX} reminders — reminders stopped. Worth a phone call.`);
        await notifyClaimFollowers(c.id, null, `Client form not coming back — ${claimLabel(c)}`,
          `${CHASE_MAX} reminders sent and the form still isn't in. Chasing has stopped; restart it or phone them.`,
          { priority: 'high' });
        out.escalated++;
        continue;
      }

      // Quiet if the form just went out or the client is working on it.
      const recent = await query(
        `SELECT GREATEST(
            (SELECT MAX(sent_at) FROM incident_claim_links WHERE claim_id = $1),
            (SELECT MAX(created_at) FROM incident_claim_events
              WHERE claim_id = $1 AND created_by IS NULL AND event_type = ANY($2::text[]))
          ) > NOW() - ($3 || ' hours')::interval AS busy`,
        [c.id, CLIENT_EVENTS, String(QUIET_HOURS)],
      );
      if (recent.rows[0]?.busy) { out.skipped++; continue; }

      const links = await query(
        `SELECT token, recipient_name, recipient_email FROM incident_claim_links
         WHERE claim_id = $1 AND status IN ('sent', 'opened') AND recipient_email IS NOT NULL
         ORDER BY created_at`,
        [c.id],
      );
      if (!links.rows.length) { out.skipped++; continue; }

      const level = c.chase_level + 1;
      const progress = formProgress(c);
      const sentTo: string[] = [];
      for (const l of links.rows) {
        const ok = await sendChaseEmail({
          token: l.token, email: l.recipient_email, name: l.recipient_name,
          reg: c.vehicle_reg || 'our van', hh: c.hh_job_number, progress, level,
        });
        if (ok) sentTo.push(l.recipient_name || l.recipient_email);
      }
      if (!sentTo.length) { out.skipped++; continue; }   // nothing went — try again tomorrow at the same level
      await query(`UPDATE incident_claims SET chase_level = $2, updated_at = NOW() WHERE id = $1`, [c.id, level]);
      await logClaimEvent(c.id, null, 'chase_sent',
        `Reminder ${level} of ${CHASE_MAX} sent to ${sentTo.join(', ')} (${progress.done} of ${progress.total} done)`);
      out.chased++;
    } catch (err) {
      console.error(`[claim-chase] case ${c.id} failed:`, err);
    }
  }
  return out;
}
