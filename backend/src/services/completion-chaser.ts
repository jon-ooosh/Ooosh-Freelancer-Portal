/**
 * Completion Chaser
 *
 * Chases freelancers for overdue D&C / crewed job completions.
 * Ported from the Netlify function netlify/functions/completion-reminders.ts
 * so the OP is authoritative (no dependency on Monday.com).
 *
 * Reminder ladder (hours after the chase clock starts — services/quote-schedule.ts
 * CHASE_FROM_SQL: a delivery/collection's `job_date + arrival_time`, UK time; a
 * crew or People job's 09:00 UK the day after its last day, Oct 2026):
 *   Level 1:  2h  → freelancer email
 *   Level 2:  6h  → freelancer email + a text, when we have their mobile
 *   Level 3: 14h  → freelancer email + staff escalation to info@oooshtours.co.uk
 *
 * The text goes once per quote, the first time it reaches level 2 or beyond (a
 * run outside business hours can jump straight from 1 to 3). Off switch:
 * system_settings.completion_chase_sms_enabled (migration 322).
 *
 * The email's button and the text's link are the same: completionLink().
 *
 * Business hours (London): 07:00–22:00. Skip outside those hours.
 * Idempotent: bumps completion_reminder_level BEFORE sending so a scheduler
 * re-run within a minute doesn't double-send.
 *
 * Triggered by scheduler.ts every 30 minutes.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { greetingName, fullDisplayName } from './display-name';
import { CHASE_FROM_SQL, isEndKeyed } from './quote-schedule';
import { smsService, normaliseMsisdn, isMobileNumber, plainSmsText } from './sms-service';
import { getSystemSetting } from '../routes/system-settings';

/** The reminder level that also goes by text. */
export const TEXT_AT_LEVEL = 2;
export const SMS_SETTING_KEY = 'completion_chase_sms_enabled';

const BUSINESS_START_HOUR = 7;
const BUSINESS_END_HOUR = 22;

/**
 * True if London local time is within working hours (07:00–22:00).
 * We use Europe/London so BST/GMT is handled automatically.
 */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const londonHour = parseInt(
    now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }),
    10
  );
  return londonHour >= BUSINESS_START_HOUR && londonHour < BUSINESS_END_HOUR;
}

interface OverdueQuote {
  id: string;
  job_type: string;
  what_is_it: string | null;
  /** Hours since the chase clock started (computed in SQL, UK time). */
  hours_past: string | number;
  job_name: string | null;
  venue_name: string | null;
  job_date: string;
  arrival_time: string | null;
  completion_reminder_level: number;
  van_leg_done_at: string | Date | null;
  freelancer_id: string;
  freelancer_email: string | null;
  freelancer_first_name: string | null;
  freelancer_preferred_name: string | null;
  freelancer_last_name: string | null;
  freelancer_mobile: string | null;
  freelancer_international_phone: string | null;
  freelancer_phone: string | null;
  agreed_rate: string | null;
}

function portalBase(): string {
  return (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
}

/**
 * Where the reminder sends them: the next thing they have to do on the portal.
 *   - Crew and People work has no van step: the completion page.
 *   - A delivery / collection whose van step is done: the completion page (the
 *     backline is what's left).
 *   - Any other delivery / collection: the Start screen (van / backline /
 *     both), where the van's photos and condition report happen. Straight to
 *     the completion page, a job that never went through Start closed with no
 *     van recorded at all (HH 16535, Oct 2026).
 * The same rule as the job page's own button (Start for a D&C job not done).
 */
export function completionLink(row: {
  id: string;
  job_type?: unknown;
  what_is_it?: unknown;
  van_leg_done_at?: unknown;
}): string {
  const finishing = isEndKeyed(row) || row.van_leg_done_at != null;
  return `${portalBase()}/job/${row.id}/${finishing ? 'complete' : 'start'}`;
}

/**
 * The number to text: their mobile, else their international number, else
 * their phone, the first that is a real mobile (never a landline). Null when
 * none is, and they get the email only.
 */
export function textableNumber(row: {
  freelancer_mobile?: string | null;
  freelancer_international_phone?: string | null;
  freelancer_phone?: string | null;
}): string | null {
  for (const n of [row.freelancer_mobile, row.freelancer_international_phone, row.freelancer_phone]) {
    const e164 = normaliseMsisdn(n, null)?.e164;
    if (e164 && isMobileNumber(e164)) return e164;
  }
  return null;
}

/** The text's variables: "your collection at Heathrow" + the link. */
export function completionTextVariables(
  row: Pick<OverdueQuote, 'id' | 'job_type' | 'what_is_it' | 'van_leg_done_at' | 'venue_name'>,
  kind: string,
): Record<string, string> {
  const venue = plainSmsText(row.venue_name, 30);
  return {
    kind,
    venuePart: venue ? ` at ${venue}` : '',
    link: completionLink(row),
  };
}

/**
 * Work out what reminder level should be sent now, based on elapsed hours.
 * Returns 0 if nothing due.
 */
export function levelDueForElapsed(hours: number, currentLevel: number): number {
  if (hours >= 14 && currentLevel < 3) return 3;
  if (hours >= 6 && currentLevel < 2) return 2;
  if (hours >= 2 && currentLevel < 1) return 1;
  return 0;
}

/**
 * Main scheduler entry point. Scans overdue incomplete quotes and
 * dispatches reminders at the appropriate level.
 */
export async function runCompletionChase(): Promise<{ scanned: number; sent: number; skipped: number; texted: number }> {
  if (!isWithinBusinessHours()) {
    return { scanned: 0, sent: 0, skipped: 0, texted: 0 };
  }

  // Overdue candidates: confirmed, not completed/cancelled, with a live
  // assignment to anyone with an email (Ooosh crew via the info@ shared account
  // included — they get chased on the same ladder because completion
  // accountability bypasses the portal mute). The chase clock is CHASE_FROM_SQL
  // (one definition with the portal's "complete from"); only quotes whose clock
  // started in the last 3 days are looked at, so a week-long tour is chased
  // after its LAST day, not dropped or chased on day one.
  const candidates = await query(
    `SELECT c.*, EXTRACT(EPOCH FROM (NOW() - c.chase_from)) / 3600 AS hours_past FROM (
       SELECT q.id, q.job_type, q.what_is_it, q.venue_name, q.job_date, q.arrival_time,
              COALESCE(q.completion_reminder_level, 0) AS completion_reminder_level,
              q.van_leg_done_at,
              ${CHASE_FROM_SQL} AS chase_from,
              qa.agreed_rate,
              p.id AS freelancer_id, p.email AS freelancer_email,
              p.first_name AS freelancer_first_name, p.last_name AS freelancer_last_name,
              p.preferred_name AS freelancer_preferred_name,
              p.mobile AS freelancer_mobile, p.international_phone AS freelancer_international_phone,
              p.phone AS freelancer_phone,
              j.job_name
       FROM quotes q
       JOIN quote_assignments qa ON qa.quote_id = q.id
       JOIN people p ON p.id = qa.person_id
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE q.status = 'confirmed'
         AND q.ops_status NOT IN ('completed', 'cancelled')
         AND q.is_deleted = false
         AND qa.status NOT IN ('declined', 'cancelled', 'completed')
         AND p.email IS NOT NULL
         AND q.job_date IS NOT NULL
         -- Cheap bound before the per-row clock maths (no tour runs 4 months).
         AND q.job_date >= CURRENT_DATE - 120
         AND q.job_date <= CURRENT_DATE + 1
         AND COALESCE(q.completion_reminder_level, 0) < 3
         -- Operational-only gate (mirrors arranging-chaser): never chase
         -- "please complete" for an enquiry / provisional / paused / lost /
         -- cancelled job. A quote's own job_date can be stale (e.g. the hire
         -- got pushed to next year but the quote row kept its old date), so the
         -- underlying job's pipeline_status is the source of truth for whether
         -- this hire is actually happening. Local D&C quotes (no linked job)
         -- always pass through. NULL pipeline_status falls back to HH numeric.
         AND (
           j.id IS NULL
           OR j.pipeline_status IN ('confirmed','prepping','prepped','dispatched','returned_incomplete','returned','completed')
           OR (j.pipeline_status IS NULL AND j.status IN (2,3,4,5,6,7,8,11))
         )
     ) c
     WHERE c.chase_from <= NOW()
       AND c.chase_from >= NOW() - INTERVAL '3 days'
     ORDER BY c.id`
  );
  const rows = candidates.rows as OverdueQuote[];

  // One quote can have several people on it (a crew, two drivers). The level is
  // per QUOTE, so bump it once and email everyone on it — bumping per row let
  // the first person's bump block every other person's email (Oct 2026).
  const byQuote = new Map<string, OverdueQuote[]>();
  for (const row of rows) {
    const list = byQuote.get(row.id);
    if (list) list.push(row);
    else byQuote.set(row.id, [row]);
  }

  let sent = 0;
  let skipped = 0;
  let texted = 0;
  // The text's off switch, read once per run and only when a text is due.
  let textsOn: boolean | null = null;

  for (const [quoteId, people] of byQuote) {
    const hours = Number(people[0].hours_past);
    const level = levelDueForElapsed(hours, people[0].completion_reminder_level);
    if (level === 0) {
      skipped += people.length;
      continue;
    }
    // Text once per quote: the first time it reaches the text level or beyond.
    const textDue = level >= TEXT_AT_LEVEL && Number(people[0].completion_reminder_level) < TEXT_AT_LEVEL;
    if (textDue && textsOn === null) {
      try {
        textsOn = (await getSystemSetting(SMS_SETTING_KEY)) !== 'false';
      } catch (err) {
        console.error('[completion-chaser] Could not read the text setting; emails only this run:', err);
        textsOn = false;
      }
    }

    // Bump level FIRST so concurrent runs don't double-send.
    // Uses conditional update — if another worker already moved us past,
    // skip.
    const updateResult = await query(
      `UPDATE quotes
       SET completion_reminder_level = $1,
           completion_last_reminder_at = NOW(),
           updated_at = NOW()
       WHERE id = $2
         AND COALESCE(completion_reminder_level, 0) < $1
       RETURNING id`,
      [level, quoteId]
    );
    if (updateResult.rows.length === 0) {
      skipped += people.length;
      continue;
    }

    for (const row of people) {
      const freelancerName = greetingName({
        first_name: row.freelancer_first_name,
        preferred_name: row.freelancer_preferred_name,
      });
      const jobName = row.job_name || row.venue_name || 'your job';
      const venueName = row.venue_name || 'the venue';
      // Crew and People work is chased after its last day (quote-schedule.ts);
      // its completion has no signature, so the copy says so.
      const endKeyed = isEndKeyed(row);
      const kind = row.job_type === 'crewed' ? 'crew job'
        : row.what_is_it === 'people' ? 'job'
        : row.job_type === 'delivery' || row.job_type === 'collection' ? row.job_type
        : 'job';
      const portalUrl = completionLink(row);

      const levelLabel = level === 1 ? 'friendly reminder' : level === 2 ? 'second reminder' : 'final reminder';
      const subject = `${levelLabel[0].toUpperCase() + levelLabel.slice(1)} — please complete ${jobName}`;
      const htmlBody = `
        <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Completion outstanding</h2>
        <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
          Hi ${freelancerName},
        </p>
        <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
          Our records show your ${kind} at <strong>${venueName}</strong>
          hasn't been marked complete yet. Could you finish the job off on the portal as soon as you can?
        </p>
        <p style="margin:0 0 20px;">
          <a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Complete job</a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.5;">
          ${endKeyed
            ? 'It only takes a moment: add any notes and you\'re done.'
            : 'It takes under a minute: a signature or photos, any notes, and you\'re done.'}
        </p>
        <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">
          Any questions, email <a href="mailto:info@oooshtours.co.uk" style="color:#7B5EA7;">info@oooshtours.co.uk</a>
          or call +44 (0) 1273 911382.
        </p>
      `;

      try {
        await emailService.sendRaw({
          to: row.freelancer_email!,
          subject,
          html: htmlBody,
          variant: 'internal',
        });
        sent++;
      } catch (err) {
        console.error(`[completion-chaser] Failed to email ${row.freelancer_email} (L${level}):`, err);
      }

      // The shared Ooosh crew account (info@): no text, no escalation.
      const isInfoMailbox = (row.freelancer_email || '').toLowerCase() === 'info@oooshtours.co.uk';

      // Level 2 → also a text, when they have a mobile. Not to the shared Ooosh
      // crew account (that's us). Never stops the emails: no number, SMS not
      // set up or a failed send just means no text (all logged in sms_log).
      if (textDue && textsOn && !isInfoMailbox) {
        try {
          const to = textableNumber(row);
          if (to) {
            const result = await smsService.send('completion_chase', {
              to,
              variables: completionTextVariables(row, kind),
            });
            if (result.success) texted++;
          }
        } catch (err) {
          console.error(`[completion-chaser] Failed to text ${row.freelancer_email} (L${level}):`, err);
        }
      }

      // Level 3 → staff escalation. Suppressed when the chasee IS info@ — no
      // point copying info@ to itself; the L1+L2+L3 chase emails already landed
      // there.
      if (level === 3 && !isInfoMailbox) {
        try {
          // An internal escalation subject line — still the name the office
          // knows them by, not the passport one.
          const fullName = fullDisplayName({
            first_name: row.freelancer_first_name,
            last_name: row.freelancer_last_name,
            preferred_name: row.freelancer_preferred_name,
          }) || row.freelancer_email;
          await emailService.sendRaw({
            to: 'info@oooshtours.co.uk',
            subject: `[Escalation] ${fullName} hasn't completed ${jobName}`,
            html: `
              <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Escalation — uncompleted job</h2>
              <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
                <strong>${fullName}</strong> (${row.freelancer_email}) has not marked their
                ${kind} at <strong>${venueName}</strong> (${jobName}) as complete
                despite three chase emails. Chasing started ${Math.round(hours)}h ago.
              </p>
              <p style="margin:0;font-size:13px;color:#64748b;">
                Please follow up directly.
              </p>
            `,
            variant: 'internal',
          });
        } catch (err) {
          console.error('[completion-chaser] Failed to send staff escalation:', err);
        }
      }
    }
  }

  return { scanned: rows.length, sent, skipped, texted };
}
