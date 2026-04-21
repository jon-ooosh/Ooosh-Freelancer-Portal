/**
 * Arranging Chaser
 *
 * Chases STAFF (not freelancers) about transport/crew quotes that are still
 * sitting in ops_status='todo' ("To Be Arranged") as their job date
 * approaches. Replaces an old Monday.com email automation that sent
 * nudges at fixed intervals — we now do it with better-worded content
 * and a link to the OP job instead of the Monday board.
 *
 * Reminder ladder (days until the quote's job_date):
 *   Level 1:  5 days out → gentle heads-up
 *   Level 2:  3 days out → more urgent
 *   Level 3:  1 day out  → last chance before it lands
 *
 * All go to info@oooshtours.co.uk for anyone in the office to pick up.
 * Business hours (London 07:00–22:00) only — no late-night emails.
 * Idempotent: arranging_reminder_level bumped BEFORE send so concurrent
 * scheduler runs within a minute don't double-send.
 *
 * Triggered by scheduler.ts. Safe to call any time — it self-gates on
 * business hours and per-quote level.
 */
import { query } from '../config/database';
import { emailService } from './email-service';

const BUSINESS_START_HOUR = 7;
const BUSINESS_END_HOUR = 22;
const STAFF_RECIPIENT = process.env.ARRANGING_CHASER_TO || 'info@oooshtours.co.uk';

/** True if London local time is inside 07:00–22:00. */
export function isWithinBusinessHours(now: Date = new Date()): boolean {
  const londonHour = parseInt(
    now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }),
    10
  );
  return londonHour >= BUSINESS_START_HOUR && londonHour < BUSINESS_END_HOUR;
}

interface PendingQuote {
  id: string;
  job_type: string;
  what_is_it: string | null;
  venue_name: string | null;
  linked_venue_name: string | null;
  job_date: string;
  arranging_reminder_level: number;
  job_id: string | null;
  job_name: string | null;
  hh_job_number: number | null;
  client_name: string | null;
}

/** Days between a job date and today (calendar day precision, London TZ). */
function daysUntil(jobDate: string): number {
  // Strip time: compare on calendar days.
  const target = new Date(jobDate);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/** Work out what reminder level (1/2/3) is due based on days-until. */
export function levelDueForDaysUntil(days: number, currentLevel: number): number {
  if (days <= 1 && days >= 0 && currentLevel < 3) return 3;
  if (days <= 3 && days >= 0 && currentLevel < 2) return 2;
  if (days <= 5 && days >= 0 && currentLevel < 1) return 1;
  return 0;
}

function humanisedJobType(jobType: string): string {
  if (jobType === 'delivery') return 'Delivery';
  if (jobType === 'collection') return 'Collection';
  if (jobType === 'crewed') return 'Crewed job';
  return jobType;
}

function humanisedWhatIsIt(what: string | null): string {
  if (!what) return '';
  if (what === 'vehicle') return 'A vehicle';
  if (what === 'equipment') return 'Equipment';
  if (what === 'people') return 'People';
  return what;
}

function levelLabel(level: number): string {
  if (level === 3) return 'TOMORROW — not yet arranged';
  if (level === 2) return 'Arriving soon — needs arranging';
  return 'Needs arranging';
}

export async function runArrangingChase(): Promise<{ scanned: number; sent: number; skipped: number }> {
  if (!isWithinBusinessHours()) return { scanned: 0, sent: 0, skipped: 0 };

  // Pull candidates: quotes still in 'todo', date within next 5 days,
  // not at max reminder level yet, not deleted/cancelled.
  const candidates = await query(
    `SELECT q.id, q.job_type, q.what_is_it, q.venue_name, q.job_date,
            COALESCE(q.arranging_reminder_level, 0) AS arranging_reminder_level,
            q.job_id,
            v.name AS linked_venue_name,
            j.job_name, j.hh_job_number, j.client_name
     FROM quotes q
     LEFT JOIN venues v ON v.id = q.venue_id
     LEFT JOIN jobs j ON j.id = q.job_id
     WHERE q.ops_status = 'todo'
       AND q.is_deleted = false
       AND q.status NOT IN ('cancelled', 'completed')
       AND q.job_date IS NOT NULL
       AND q.job_date >= CURRENT_DATE
       AND q.job_date <= CURRENT_DATE + INTERVAL '5 days'
       AND COALESCE(q.arranging_reminder_level, 0) < 3`
  );
  const rows = candidates.rows as PendingQuote[];

  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const days = daysUntil(row.job_date);
    const level = levelDueForDaysUntil(days, row.arranging_reminder_level);
    if (level === 0) { skipped++; continue; }

    // Bump level FIRST — guards against concurrent runs.
    const updateResult = await query(
      `UPDATE quotes
         SET arranging_reminder_level = $1,
             arranging_last_reminder_at = NOW(),
             updated_at = NOW()
       WHERE id = $2
         AND COALESCE(arranging_reminder_level, 0) < $1
       RETURNING id`,
      [level, row.id]
    );
    if (updateResult.rows.length === 0) { skipped++; continue; }

    const venue = row.linked_venue_name || row.venue_name || 'TBC';
    const jobDateFormatted = new Date(row.job_date).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const jobLabel = row.hh_job_number ? `#${row.hh_job_number}` : '(no HH ref)';
    const frontendBase = (process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk').replace(/\/$/, '');
    const opLink = row.job_id ? `${frontendBase}/jobs/${row.job_id}` : `${frontendBase}/operations/transport`;
    const typeLabel = humanisedJobType(row.job_type);
    const whatPart = humanisedWhatIsIt(row.what_is_it);
    // Pre-compose phrases the template can't build (simple {{var}} only, no
    // conditionals, and values get HTML-escaped).
    const jobTypeSummary = whatPart ? `${typeLabel} of ${whatPart}` : typeLabel;
    const daysUntilLabel = days <= 0
      ? 'today'
      : days === 1
        ? '1 day'
        : `${days} days`;
    const clientLine = row.client_name ? `Client: ${row.client_name}` : ' ';

    try {
      await emailService.send('arranging_reminder', {
        to: STAFF_RECIPIENT,
        variables: {
          level: String(level),
          levelHeadline: levelLabel(level),
          daysUntilLabel,
          jobTypeLabel: typeLabel,
          jobTypeSummary,
          jobLabel,
          jobName: row.job_name || '(no job name)',
          venue,
          jobDateFormatted,
          clientLine,
          opLink,
          transportOpsLink: `${frontendBase}/operations/transport`,
        },
      });
      sent++;
    } catch (err) {
      console.error(`[arranging-chaser] Email failed for quote ${row.id} (L${level}):`, err);
    }
  }

  return { scanned: rows.length, sent, skipped };
}
