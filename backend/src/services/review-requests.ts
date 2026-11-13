/**
 * Jon's review request email (docs/BUSINESS-FIGURES-SPEC.md §8c).
 *
 * The day after a hire is Completed, a short personal email from Jon asks the client
 * for a Google review, says "reply if anything went wrong", and carries a referral
 * line and a mailing-list link. Rules (jon, 13 Nov 2026):
 *   - only when the job was completed within TEN days of its return (a long close-out
 *     usually means a claim or a dispute — jon's call, knowing Google frowns on asking
 *     selectively);
 *   - a "don't send" tick on the job (a `skipped` row);
 *   - at most once a year per client — the organisation or the email address;
 *   - never to someone who used "Don't ask me again";
 *   - never on an internal job, never to the info@ safety net.
 * Every job gets ONE row in `review_requests`, written BEFORE the email goes (stamp
 * first, then send — a failure never sends twice). Off until jon turns it on
 * (`system_settings.review_requests_enabled`, Marketing › Review emails).
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { resolveClientEmailTarget } from './money-emails';
import { signFor, verifyFor } from './tokens';
import { ukToday } from './uk-date';

export const REVIEW_SETTING_KEY = 'review_requests_enabled';
export const REVIEW_TEMPLATE = 'review_request';
/** Ooosh's Google review box (jon, Nov 2026). */
export const GOOGLE_REVIEW_URL = 'https://g.page/r/CSCv1HhULJ6nEAI/review';
/**
 * The Mailchimp sign-up form. `legacy_form=1` asks for Mailchimp's classic form, which
 * fills in MERGE0/1/2 (email, first, last name) from the link — checked 13 Nov 2026.
 * The newer form is drawn by a script and may not.
 */
export const MAILING_LIST_FORM = 'https://oooshtours.us17.list-manage.com/subscribe?u=63764bf98ab1047f069e39503&id=bc98a89c7c&legacy_form=1';
export const REPLY_TO = 'jon@oooshtours.co.uk';
export const FROM_NAME = 'Jon at Ooosh Tours';
/** Completed more than this many days after the hire came back → not asked. */
export const MAX_DAYS_AFTER_RETURN = 10;
/** At most one ask per client (organisation or address) in this many days. */
export const ONCE_PER_DAYS = 365;
/** A run looks back this many days, so a missed run (a restart, a weekend) still catches up. */
const CATCH_UP_DAYS = 3;
const PUBLIC_BASE = process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk';

// ── The pure parts ───────────────────────────────────────────────────────────

/** "How did it go, Sam?" — or "How did it go?" with no usable name. Never a placeholder. */
export function reviewSubject(name: string): string {
  const n = name.trim();
  return n ? `How did it go, ${n}?` : 'How did it go?';
}

/** The Mailchimp form with their email and name already filled in. */
export function mailingListUrl(email: string, firstName?: string | null, lastName?: string | null): string {
  const u = new URL(MAILING_LIST_FORM);
  if (email) u.searchParams.set('MERGE0', email);
  if (firstName?.trim()) u.searchParams.set('MERGE1', firstName.trim());
  if (lastName?.trim()) u.searchParams.set('MERGE2', lastName.trim());
  return u.toString();
}

/** Whole days from the hire's return to its completion (UK dates, YYYY-MM-DD). Null if either is missing. */
export function daysAfterReturn(returnedOn: string | null, completedOn: string | null): number | null {
  if (!returnedOn || !completedOn) return null;
  const a = Date.parse(`${returnedOn}T00:00:00Z`);
  const b = Date.parse(`${completedOn}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export interface ReviewFacts {
  completedOn: string | null;   // UK date the job went to Completed
  returnedOn: string | null;    // UK date it was due back (return date, else job end)
  isInternal: boolean;
  email: string | null;         // who the email would go to (null = only the info@ safety net)
  optedOut: boolean;
  askedRecently: boolean;       // this organisation or address was asked in the last year
}

/** Send, or the reason not to — in plain words for the Marketing page. */
export function reviewDecision(f: ReviewFacts): { send: true } | { send: false; reason: string } {
  if (f.isInternal) return { send: false, reason: 'Internal job' };
  const days = daysAfterReturn(f.returnedOn, f.completedOn);
  if (days === null) return { send: false, reason: 'No return date on the job' };
  if (days > MAX_DAYS_AFTER_RETURN) return { send: false, reason: `Completed ${days} days after the return (over ${MAX_DAYS_AFTER_RETURN})` };
  if (!f.email) return { send: false, reason: 'No client email address' };
  if (f.optedOut) return { send: false, reason: 'They asked not to be asked again' };
  if (f.askedRecently) return { send: false, reason: 'Already asked in the last year' };
  return { send: true };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function isReviewRequestsEnabled(): Promise<boolean> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [REVIEW_SETTING_KEY]);
  return String(r.rows[0]?.value ?? 'false').trim().toLowerCase() === 'true';
}

export async function setReviewRequestsEnabled(on: boolean, userId: string): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, label, category, value_type, sort_order, updated_by, updated_at)
     VALUES ($1, $2, 'Send Jon''s review request email the day after a hire is completed (Marketing › Review emails)', 'marketing', 'bool', 60, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [REVIEW_SETTING_KEY, on ? 'true' : 'false', userId],
  );
}

// ── "Don't ask me again" ─────────────────────────────────────────────────────

export function stopUrl(email: string): string {
  const t = signFor('review_optout', { email: email.toLowerCase() }, '730d');
  return `${PUBLIC_BASE}/api/review-requests/stop?t=${encodeURIComponent(t)}`;
}

/** The address a stop link was made for, or null if it's bad / expired. */
export function emailFromStopToken(token: string): string | null {
  const p = verifyFor<{ email?: string }>('review_optout', token);
  return p?.email && /@/.test(p.email) ? p.email.toLowerCase() : null;
}

export async function recordOptOut(email: string): Promise<void> {
  await query(
    `INSERT INTO review_request_optouts (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`,
    [email.toLowerCase()],
  );
}

// ── The email ────────────────────────────────────────────────────────────────

interface Recipient {
  email: string;
  name: string;          // greeting name ('' = none)
  firstName: string | null;
  lastName: string | null;
}

/** Who the review email goes to: the job's primary client address only (never the CCs). Null = info@ fallback. */
async function recipientFor(jobId: string): Promise<Recipient | null> {
  const t = await resolveClientEmailTarget(jobId, REVIEW_TEMPLATE);
  if (t.isFallback || !t.primaryEmail) return null;
  const email = t.primaryEmail.trim().toLowerCase();
  // The greeting is the resolver's own name for the primary ('' = an org mailbox or no name).
  const name = (t.recipientNames[0] || '').trim();
  // First / last name only to fill in the mailing-list form; an org mailbox has none.
  const p = await query(
    `SELECT first_name, last_name FROM people
      WHERE lower(email) = $1 AND COALESCE(is_deleted, false) = false
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [email],
  );
  return { email, name, firstName: p.rows[0]?.first_name ?? null, lastName: p.rows[0]?.last_name ?? null };
}

async function sendReviewEmail(to: string, r: Recipient, jobNumber: string, test: boolean) {
  return emailService.send(REVIEW_TEMPLATE, {
    to,
    subjectOverride: (test ? '[Test] ' : '') + reviewSubject(r.name),
    replyTo: REPLY_TO,
    fromName: FROM_NAME,
    variables: {
      name: r.name,
      hasName: r.name ? 'yes' : '',
      noName: r.name ? '' : 'yes',
      reviewUrl: GOOGLE_REVIEW_URL,
      signupUrl: mailingListUrl(r.email, r.firstName, r.lastName),
      stopUrl: stopUrl(r.email),
      jobNumber,
    },
  });
}

// ── The daily run ────────────────────────────────────────────────────────────

export interface ReviewRunSummary { enabled: boolean; sent: number; notSent: number; failed: number }

/**
 * Jobs completed yesterday (or up to CATCH_UP_DAYS back, if a run was missed) with no
 * row yet: decide, write the row, then send. Never throws for one job.
 */
export async function runReviewRequests(): Promise<ReviewRunSummary> {
  const summary: ReviewRunSummary = { enabled: false, sent: 0, notSent: 0, failed: 0 };
  if (!(await isReviewRequestsEnabled())) return summary;
  summary.enabled = true;
  const today = ukToday();
  const jobs = await query(
    `SELECT j.id, j.client_id, j.hh_job_number, COALESCE(j.is_internal, false) AS is_internal,
            to_char((j.pipeline_status_changed_at AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS completed_on,
            to_char((COALESCE(j.return_date, j.job_end) AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS returned_on
       FROM jobs j
      WHERE j.pipeline_status = 'completed'
        AND COALESCE(j.is_deleted, false) = false
        AND j.pipeline_status_changed_at IS NOT NULL
        AND (j.pipeline_status_changed_at AT TIME ZONE 'Europe/London')::date < $1::date
        AND (j.pipeline_status_changed_at AT TIME ZONE 'Europe/London')::date >= $1::date - $2::int
        AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.job_id = j.id)
      ORDER BY j.pipeline_status_changed_at`,
    [today, CATCH_UP_DAYS],
  );

  for (const j of jobs.rows as Array<{ id: string; client_id: string | null; hh_job_number: number | null; is_internal: boolean; completed_on: string; returned_on: string | null }>) {
    try {
      const r = j.is_internal ? null : await recipientFor(j.id);
      const facts: ReviewFacts = {
        completedOn: j.completed_on, returnedOn: j.returned_on, isInternal: j.is_internal,
        email: r?.email ?? null, optedOut: false, askedRecently: false,
      };
      if (r) {
        const o = await query(`SELECT 1 FROM review_request_optouts WHERE email = $1`, [r.email]);
        facts.optedOut = o.rows.length > 0;
        // Rows written earlier in THIS run count too, so two jobs for one client send once.
        const recent = await query(
          `SELECT 1 FROM review_requests
            WHERE status = 'sent' AND sent_at > NOW() - make_interval(days => $3::int)
              AND (sent_to = $1 OR ($2::uuid IS NOT NULL AND client_id = $2::uuid)) LIMIT 1`,
          [r.email, j.client_id, ONCE_PER_DAYS],
        );
        facts.askedRecently = recent.rows.length > 0;
      }
      const d = reviewDecision(facts);
      if (!d.send) {
        await query(
          `INSERT INTO review_requests (job_id, status, reason) VALUES ($1, 'not_sent', $2) ON CONFLICT (job_id) DO NOTHING`,
          [j.id, d.reason],
        );
        summary.notSent++;
        continue;
      }
      // Stamp first, then send.
      const claim = await query(
        `INSERT INTO review_requests (job_id, status, sent_to, client_id, sent_at)
         VALUES ($1, 'sent', $2, $3, NOW()) ON CONFLICT (job_id) DO NOTHING RETURNING id`,
        [j.id, r!.email, j.client_id],
      );
      if (!claim.rows.length) continue; // someone else got there (a tick, a second run)
      const result = await sendReviewEmail(r!.email, r!, String(j.hh_job_number || ''), false);
      if (!result.success) {
        await query(
          `UPDATE review_requests SET status = 'not_sent', reason = $2, sent_at = NULL, updated_at = NOW() WHERE id = $1`,
          [claim.rows[0].id, `Email failed: ${(result.error || 'unknown').slice(0, 240)}`],
        );
        summary.failed++;
        continue;
      }
      await query(
        `INSERT INTO interactions (type, content, job_id, source) VALUES ('email', $1, $2, 'system')`,
        [`Jon's review request email sent to ${r!.email}.`, j.id],
      ).catch((err) => console.error('[review-requests] timeline note not written (non-fatal):', err));
      summary.sent++;
    } catch (err) {
      console.error(`[review-requests] job ${j.id}:`, err);
    }
  }
  return summary;
}

// ── Staff: the job's tick, the Marketing tab ────────────────────────────────

export interface JobReviewState {
  status: 'pending' | 'skipped' | 'sent' | 'not_sent';
  reason: string | null;
  sentTo: string | null;
  sentAt: string | null;
}

export async function getJobReviewState(jobId: string): Promise<JobReviewState> {
  const r = await query(`SELECT status, reason, sent_to, sent_at FROM review_requests WHERE job_id = $1`, [jobId]);
  const row = r.rows[0];
  if (!row) return { status: 'pending', reason: null, sentTo: null, sentAt: null };
  return {
    status: row.status, reason: row.reason ?? null, sentTo: row.sent_to ?? null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
  };
}

/** "Don't send" on a job: ticked writes a `skipped` row; unticked removes it. A sent email is never undone. */
export async function setJobReviewSkip(jobId: string, skip: boolean, userId: string): Promise<JobReviewState> {
  if (skip) {
    await query(
      `INSERT INTO review_requests (job_id, status, reason, decided_by) VALUES ($1, 'skipped', 'Ticked "don''t send"', $2)
       ON CONFLICT (job_id) DO NOTHING`,
      [jobId, userId],
    );
  } else {
    await query(`DELETE FROM review_requests WHERE job_id = $1 AND status = 'skipped'`, [jobId]);
  }
  return getJobReviewState(jobId);
}

export interface ReviewOverviewRow {
  jobId: string;
  jobNumber: number | null;
  jobName: string | null;
  status: string;
  reason: string | null;
  sentTo: string | null;
  at: string;
}

export async function reviewOverview(): Promise<{ enabled: boolean; sent30: number; optOuts: number; recent: ReviewOverviewRow[] }> {
  const [enabled, counts, recent] = await Promise.all([
    isReviewRequestsEnabled(),
    query(`SELECT (SELECT COUNT(*)::int FROM review_requests WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days') AS sent30,
                  (SELECT COUNT(*)::int FROM review_request_optouts) AS opt_outs`),
    query(`SELECT r.job_id, j.hh_job_number, j.job_name, r.status, r.reason, r.sent_to, COALESCE(r.sent_at, r.created_at) AS at
             FROM review_requests r JOIN jobs j ON j.id = r.job_id
            ORDER BY COALESCE(r.sent_at, r.created_at) DESC LIMIT 50`),
  ]);
  return {
    enabled,
    sent30: Number(counts.rows[0]?.sent30) || 0,
    optOuts: Number(counts.rows[0]?.opt_outs) || 0,
    recent: recent.rows.map((x: Record<string, unknown>) => ({
      jobId: String(x.job_id), jobNumber: (x.hh_job_number as number) ?? null, jobName: (x.job_name as string) ?? null,
      status: String(x.status), reason: (x.reason as string) ?? null, sentTo: (x.sent_to as string) ?? null,
      at: new Date(x.at as string).toISOString(),
    })),
  };
}

/**
 * "Send me a test": the real email for the most recently completed job, sent to the
 * person asking (subject starts "[Test]"). Writes no row; the client is never emailed.
 */
export async function sendTestReviewEmail(toEmail: string): Promise<{ ok: boolean; error?: string; jobNumber?: string }> {
  const j = await query(
    `SELECT id, hh_job_number FROM jobs
      WHERE pipeline_status = 'completed' AND COALESCE(is_deleted, false) = false AND COALESCE(is_internal, false) = false
      ORDER BY pipeline_status_changed_at DESC NULLS LAST LIMIT 1`,
  );
  const job = j.rows[0];
  const real = job ? await recipientFor(job.id) : null;
  // Their name, so the greeting reads as it will; the address and links are the tester's own.
  const r: Recipient = { email: toEmail.toLowerCase(), name: real?.name ?? '', firstName: null, lastName: null };
  const result = await sendReviewEmail(toEmail, r, String(job?.hh_job_number || ''), true);
  return result.success ? { ok: true, jobNumber: String(job?.hh_job_number || '') } : { ok: false, error: result.error };
}
