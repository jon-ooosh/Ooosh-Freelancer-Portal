/**
 * Completion Chaser
 *
 * Chases freelancers for overdue D&C / crewed job completions.
 * Ported from the Netlify function netlify/functions/completion-reminders.ts
 * so the OP is authoritative (no dependency on Monday.com).
 *
 * Reminder ladder (hours after the quote's scheduled `job_date + arrival_time`):
 *   Level 1:  2h  → freelancer email
 *   Level 2:  6h  → freelancer email
 *   Level 3: 14h  → freelancer email + staff escalation to info@oooshtours.co.uk
 *
 * Business hours (London): 07:00–22:00. Skip outside those hours.
 * Idempotent: bumps completion_reminder_level BEFORE sending so a scheduler
 * re-run within a minute doesn't double-send.
 *
 * Triggered by scheduler.ts every 30 minutes.
 */
import { query } from '../config/database';
import { emailService } from './email-service';

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
  job_name: string | null;
  venue_name: string | null;
  job_date: string;
  arrival_time: string | null;
  completion_reminder_level: number;
  freelancer_id: string;
  freelancer_email: string | null;
  freelancer_first_name: string | null;
  freelancer_last_name: string | null;
  agreed_rate: string | null;
}

/**
 * Compute how many hours past the job's scheduled time we are.
 * Uses job_date + arrival_time; if arrival_time is missing, uses midday.
 */
function hoursPastJob(row: { job_date: string; arrival_time: string | null }): number {
  const date = new Date(row.job_date);
  const [hStr, mStr] = (row.arrival_time || '12:00').split(':');
  date.setHours(parseInt(hStr, 10) || 12, parseInt(mStr, 10) || 0, 0, 0);
  return (Date.now() - date.getTime()) / (1000 * 60 * 60);
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
export async function runCompletionChase(): Promise<{ scanned: number; sent: number; skipped: number }> {
  if (!isWithinBusinessHours()) {
    return { scanned: 0, sent: 0, skipped: 0 };
  }

  // Fetch overdue candidates: confirmed, not completed/cancelled,
  // with a crew assignment to anyone with an email (Ooosh crew via the
  // info@ shared account included — they get chased on the same ladder
  // because completion accountability bypasses the portal mute).
  // Looking back 48h to catch stragglers but not run wild.
  const candidates = await query(
    `SELECT q.id, q.job_type, q.venue_name, q.job_date, q.arrival_time,
            COALESCE(q.completion_reminder_level, 0) AS completion_reminder_level,
            qa.agreed_rate,
            p.id AS freelancer_id, p.email AS freelancer_email,
            p.first_name AS freelancer_first_name, p.last_name AS freelancer_last_name,
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
       AND q.job_date >= NOW() - INTERVAL '3 days'
       AND q.job_date <= NOW()
       AND COALESCE(q.completion_reminder_level, 0) < 3`
  );
  const rows = candidates.rows as OverdueQuote[];

  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const hours = hoursPastJob(row);
    const level = levelDueForElapsed(hours, row.completion_reminder_level);
    if (level === 0) {
      skipped++;
      continue;
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
      [level, row.id]
    );
    if (updateResult.rows.length === 0) {
      skipped++;
      continue;
    }

    const freelancerName = (row.freelancer_first_name || '').trim() || 'there';
    const jobName = row.job_name || row.venue_name || 'your job';
    const venueName = row.venue_name || 'the venue';
    const portalUrl =
      (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '') +
      `/job/${row.id}/complete`;

    const levelLabel = level === 1 ? 'friendly reminder' : level === 2 ? 'second reminder' : 'final reminder';
    const subject = `${levelLabel[0].toUpperCase() + levelLabel.slice(1)} — please complete ${jobName}`;
    const htmlBody = `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Completion outstanding</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
        Hi ${freelancerName},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
        Our records show your ${row.job_type || 'job'} at <strong>${venueName}</strong>
        hasn't been marked complete yet. Could you finish the job off on the portal as soon as you can?
      </p>
      <p style="margin:0 0 20px;">
        <a href="${portalUrl}" style="display:inline-block;padding:12px 24px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Complete job</a>
      </p>
      <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.5;">
        It takes under a minute — signature or photos, any notes, and you're done.
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

    // Level 3 → staff escalation. Suppressed when the chasee IS info@ — no
    // point copying info@ to itself; the L1+L2+L3 chase emails already landed
    // there.
    const isInfoMailbox = (row.freelancer_email || '').toLowerCase() === 'info@oooshtours.co.uk';
    if (level === 3 && !isInfoMailbox) {
      try {
        const fullName = `${row.freelancer_first_name || ''} ${row.freelancer_last_name || ''}`.trim()
          || row.freelancer_email;
        await emailService.sendRaw({
          to: 'info@oooshtours.co.uk',
          subject: `[Escalation] ${fullName} hasn't completed ${jobName}`,
          html: `
            <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Escalation — uncompleted job</h2>
            <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
              <strong>${fullName}</strong> (${row.freelancer_email}) has not marked their
              ${row.job_type || 'job'} at <strong>${venueName}</strong> (${jobName}) as complete
              despite three chase emails. Job was scheduled ${Math.round(hours)}h ago.
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

  return { scanned: rows.length, sent, skipped };
}
