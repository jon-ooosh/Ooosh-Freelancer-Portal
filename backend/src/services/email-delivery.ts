/**
 * email-delivery.ts — hearing back from Resend about emails that did NOT arrive.
 *
 * OP hands an email to Resend, Resend answers "accepted", and email_log says
 * 'sent'. What happens AFTER that used to be invisible: a bounce, a block
 * because the address is on Resend's suppression list, a spam report. A client
 * could miss a booking confirmation or a hire form while OP's record said it
 * went (job 16893, Oct 2026 — a CC address that had hard-bounced was being
 * suppressed on every email; it was spotted by eye in the Resend dashboard).
 *
 * Resend calls POST /api/webhooks/resend (mounted in index.ts with the RAW
 * body, before express.json — the signature is over the exact bytes).
 *
 *   email.bounced / email.suppressed / email.complained / email.failed
 *       → one email_delivery_events row per impacted recipient
 *       → the address is flagged in email_address_problems (not for 'failed',
 *         which is a sending error, not an address problem)
 *       → a line on the job's timeline (or the person's, when there is no job)
 *       → a bell to managers + an email to info@ — deduped per address per
 *         job per 24h while the address stays flagged
 *   email.delivered
 *       → clears the flag on an address that has since received an email
 *
 * NEVER retries a send and NEVER removes an address from Resend's suppression
 * list: both would hide the problem and harm our sending reputation. A person
 * fixes the address (or confirms it and removes it in Resend) and re-sends.
 *
 * Resend checks each recipient separately: one email can be delivered to the
 * To and suppressed for a CC. Resend's list view shows the whole row as
 * "Suppressed" if ANY recipient was — the per-recipient detail is on the email.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { query } from '../config/database';
import { frontendLink } from '../config/app-urls';
import { MANAGER_ROLES } from '../middleware/auth';
import { emailService } from './email-service';

const ALERT_EMAIL = 'info@oooshtours.co.uk';
const OWN_DOMAIN = '@oooshtours.co.uk';
/** Svix (which signs Resend's webhooks) recommends a 5-minute window. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type ProblemKind = 'bounced' | 'suppressed' | 'complained';
export type BadEventKind = ProblemKind | 'failed';

// ── Signature ────────────────────────────────────────────────────────────

/**
 * Verify a Resend webhook the way Svix signs it: base64 HMAC-SHA256, keyed by
 * the base64 part of the `whsec_…` secret, over `${id}.${timestamp}.${body}`.
 * The header can carry several space-separated `v1,<sig>` entries; any match
 * passes. Timestamps more than 5 minutes off are refused (replays).
 */
export function verifyResendSignature(opts: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signatureHeader, body } = opts;
  if (!secret || !id || !timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();

  return signatureHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// ── Payload ──────────────────────────────────────────────────────────────

/** The fields of Resend's email.* webhook payload that we read. */
export interface ResendEmailEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { message?: string; type?: string; subType?: string; diagnosticCode?: string[] };
    suppressed?: { message?: string; type?: string };
    failed?: { reason?: string };
  };
}

/** `Name <a@b.com>` or ` A@B.com ` → `a@b.com`. */
export function normaliseAddress(raw: string): string {
  const s = String(raw || '').trim();
  const angled = s.match(/<([^>]+)>/);
  return (angled ? angled[1] : s).trim().toLowerCase();
}

function recipientsOf(event: ResendEmailEvent): string[] {
  const to = event.data?.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  // 320 = the column width; a longer "address" can't be real and would fail the
  // insert on every retry.
  return [...new Set(list.map(normaliseAddress).filter((a) => a.includes('@') && a.length <= 320))];
}

export function badEventKind(type: string): BadEventKind | null {
  switch (type) {
    case 'email.bounced': return 'bounced';
    case 'email.suppressed': return 'suppressed';
    case 'email.complained': return 'complained';
    case 'email.failed': return 'failed';
    default: return null;
  }
}

/** Resend's own reason, as given — stored and shown alongside our wording. */
export function eventDetail(kind: BadEventKind, data: ResendEmailEvent['data']): string {
  if (kind === 'bounced') {
    const b = data?.bounce || {};
    return [
      b.type ? `${b.type} bounce${b.subType ? ` (${b.subType})` : ''}` : 'Bounced',
      b.message,
      Array.isArray(b.diagnosticCode) ? b.diagnosticCode[0] : undefined,
    ].filter(Boolean).join(' — ');
  }
  if (kind === 'suppressed') {
    return data?.suppressed?.message || 'The address is on Resend\'s suppression list.';
  }
  if (kind === 'complained') return 'The recipient marked one of our emails as spam.';
  return data?.failed?.reason ? `Failed to send: ${data.failed.reason}` : 'Failed to send.';
}

/** What happened, in words a person acts on. */
export function plainReason(kind: BadEventKind): string {
  switch (kind) {
    case 'bounced':
      return 'it bounced: the recipient\'s mail server refused it (usually a mistyped or closed address)';
    case 'suppressed':
      return 'it was not sent: Resend has blocked this address because earlier emails to it bounced or were reported as spam';
    case 'complained':
      return 'the recipient reported it as spam, so Resend will not send to them again';
    default:
      return 'Resend could not send it';
  }
}

export function whatToDo(kind: BadEventKind): string {
  switch (kind) {
    case 'complained':
      return 'Speak to them. Only if they do want our emails: remove the address from Resend\'s suppression list (Resend › Emails › Suppressions) and re-send.';
    case 'failed':
      return 'Re-send it. If it fails again, check the Resend dashboard.';
    default:
      return 'Check the address with them by phone or text. If it is wrong, correct it in OP and re-send. If it is right, remove it from Resend\'s suppression list (Resend › Emails › Suppressions) first, then re-send.';
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Lookups ──────────────────────────────────────────────────────────────

interface LoggedEmail {
  id: string;
  template_id: string;
  recipient: string;
  subject: string;
  job_number: number | null;
}

interface JobRef { id: string; hh_job_number: number | null; job_name: string | null }

async function findLoggedEmail(providerEmailId: string | undefined): Promise<LoggedEmail | null> {
  if (!providerEmailId) return null;
  const r = await query(
    `SELECT id, template_id, recipient, subject, job_number
       FROM email_log WHERE message_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [providerEmailId],
  );
  return (r.rows[0] as LoggedEmail | undefined) || null;
}

async function findJob(jobNumber: number | null): Promise<JobRef | null> {
  if (!jobNumber) return null;
  const r = await query(
    `SELECT id, hh_job_number, job_name FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
    [jobNumber],
  );
  return (r.rows[0] as JobRef | undefined) || null;
}

/** The address-book record an address belongs to — the fallback link and
 *  timeline when the email was not about a job. */
async function findAddressOwner(email: string): Promise<{ personId: string | null; orgId: string | null }> {
  const p = await query(
    `SELECT id FROM people
      WHERE lower(email) = $1 AND COALESCE(is_deleted, false) = false
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  if (p.rows[0]) return { personId: (p.rows[0] as { id: string }).id, orgId: null };
  const o = await query(
    `SELECT id FROM organisations
      WHERE lower(email) = $1 AND COALESCE(is_deleted, false) = false
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  return { personId: null, orgId: (o.rows[0] as { id: string } | undefined)?.id || null };
}

// ── Recording ────────────────────────────────────────────────────────────

/**
 * Flag (or re-flag) an address. Returns whether it was ALREADY flagged before
 * this failure — a re-opened or brand-new problem always alerts.
 */
async function flagAddress(email: string, kind: ProblemKind, detail: string): Promise<boolean> {
  const prev = await query(
    `SELECT resolved_at FROM email_address_problems WHERE email = $1`,
    [email],
  );
  const wasOpen = prev.rows.length > 0 && (prev.rows[0] as { resolved_at: Date | null }).resolved_at === null;

  await query(
    `INSERT INTO email_address_problems (email, problem, detail)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       problem       = EXCLUDED.problem,
       detail        = EXCLUDED.detail,
       last_seen_at  = NOW(),
       first_seen_at = CASE WHEN email_address_problems.resolved_at IS NULL
                            THEN email_address_problems.first_seen_at ELSE NOW() END,
       failed_count  = CASE WHEN email_address_problems.resolved_at IS NULL
                            THEN email_address_problems.failed_count + 1 ELSE 1 END,
       resolved_at   = NULL,
       resolved_by   = NULL,
       resolved_how  = NULL,
       updated_at    = NOW()`,
    [email, kind, detail],
  );
  return wasOpen;
}

/** Already alerted about this address on this job (or both job-less) in the
 *  last 24 hours? */
async function recentlyAlerted(email: string, jobId: string | null): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM email_delivery_events
      WHERE recipient = $1 AND alerted = true
        AND job_id IS NOT DISTINCT FROM $2::uuid
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1`,
    [email, jobId],
  );
  return r.rows.length > 0;
}

interface FailureContext {
  kind: BadEventKind;
  recipient: string;
  onCc: boolean;
  subject: string;
  detail: string;
  job: JobRef | null;
  personId: string | null;
  orgId: string | null;
}

function jobLabel(job: JobRef | null): string {
  if (!job) return '';
  return [job.hh_job_number ? `job #${job.hh_job_number}` : null, job.job_name].filter(Boolean).join(' — ');
}

async function writeTimeline(ctx: FailureContext): Promise<void> {
  if (!ctx.job && !ctx.personId && !ctx.orgId) return;
  const content = `Email NOT delivered to ${ctx.recipient}${ctx.onCc ? ' (CC)' : ''}: "${ctx.subject}" — `
    + `${plainReason(ctx.kind)}. What to do: ${whatToDo(ctx.kind)} (Resend: ${ctx.detail})`;
  try {
    await query(
      `INSERT INTO interactions (type, content, job_id, person_id, organisation_id, source)
       VALUES ('email', $1, $2, $3, $4, 'system')`,
      // A job-scoped failure goes on the job only — entity timelines are kept
      // to their own entity (email rules, "Timelines & threads").
      ctx.job ? [content, ctx.job.id, null, null] : [content, null, ctx.personId, ctx.orgId],
    );
  } catch (err) {
    console.error('[email-delivery] timeline note failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

function actionPath(ctx: FailureContext): string | null {
  if (ctx.job) return `/jobs/${ctx.job.id}`;
  if (ctx.personId) return `/people/${ctx.personId}`;
  if (ctx.orgId) return `/organisations/${ctx.orgId}`;
  return null;
}

/** Bell every manager + email info@. The bell is pre-stamped `email_sent_at`
 *  because info@ is emailed directly (email rules: one event, one email). */
async function raiseAlert(ctx: FailureContext): Promise<void> {
  const where = jobLabel(ctx.job);
  const path = actionPath(ctx);
  const title = `Email not delivered to ${ctx.recipient}${ctx.job?.hh_job_number ? ` (job #${ctx.job.hh_job_number})` : ''}`;
  const content = `"${ctx.subject}"${ctx.onCc ? ' (they were on CC)' : ''}: ${plainReason(ctx.kind)}. `
    + `What to do: ${whatToDo(ctx.kind)} (Resend: ${ctx.detail})`;

  try {
    const users = await query(
      `SELECT id FROM users
        WHERE role = ANY($1::text[]) AND is_active = true
          AND COALESCE(login_disabled, false) = false`,
      [[...MANAGER_ROLES]],
    );
    for (const u of users.rows as Array<{ id: string }>) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, email_sent_at)
         VALUES ($1, 'system', $2, $3, $4, $5, $6, 'high', NOW())`,
        [
          u.id, title.slice(0, 500), content,
          ctx.job ? 'job' : ctx.personId ? 'person' : ctx.orgId ? 'organisation' : null,
          ctx.job?.id || ctx.personId || ctx.orgId || null,
          path,
        ],
      );
    }
  } catch (err) {
    console.error('[email-delivery] bell failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  // Never email about a failure to one of our OWN addresses: if info@ itself
  // were suppressed, emailing info@ about it would fail and alert again, forever.
  if (ctx.recipient.endsWith(OWN_DOMAIN)) return;

  const lines = [
    `<strong>An email from OP did not reach ${escapeHtml(ctx.recipient)}</strong>${ctx.onCc ? ' (on CC)' : ''}.`,
    `Email: "${escapeHtml(ctx.subject)}"${where ? `<br>For: ${escapeHtml(where)}` : ''}`,
    `What happened: ${escapeHtml(plainReason(ctx.kind))}.`,
    `What to do: ${escapeHtml(whatToDo(ctx.kind))}`,
    `Resend says: ${escapeHtml(ctx.detail)}`,
    path ? `<a href="${frontendLink(path)}">Open in OP &rarr;</a>` : '',
  ].filter(Boolean);
  const subject = `Email not delivered: ${ctx.recipient}${ctx.job?.hh_job_number ? ` (job #${ctx.job.hh_job_number})` : ''}`;
  const res = await emailService
    .sendRaw({ to: ALERT_EMAIL, subject, html: `<p>${lines.join('</p><p>')}</p>`, variant: 'internal' })
    .catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e) }));
  if (!res.success) console.error('[email-delivery] info@ alert failed:', res.error);
}

/** One bad event for one recipient. Idempotent per (webhook id, recipient). */
async function recordFailure(
  webhookId: string,
  kind: BadEventKind,
  recipient: string,
  event: ResendEmailEvent,
): Promise<void> {
  const data = event.data || {};
  const logged = await findLoggedEmail(data.email_id);
  const job = await findJob(logged?.job_number ?? null);
  const owner = job ? { personId: null, orgId: null } : await findAddressOwner(recipient);
  const subject = data.subject || logged?.subject || '(no subject)';
  const detail = eventDetail(kind, data);

  const inserted = await query(
    `INSERT INTO email_delivery_events
       (webhook_id, event_type, provider_email_id, recipient, subject, detail, email_log_id, template_id, job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (webhook_id, recipient) DO NOTHING
     RETURNING id`,
    [
      webhookId, kind, data.email_id || null, recipient, subject.slice(0, 500), detail,
      logged?.id || null, logged?.template_id || null, job?.id || null,
    ],
  );
  if (inserted.rows.length === 0) return; // a retry of an event we already have
  const eventId = (inserted.rows[0] as { id: string }).id;

  const wasOpen = kind === 'failed' ? true : await flagAddress(recipient, kind, detail);

  const ctx: FailureContext = {
    kind,
    recipient,
    onCc: !!logged && normaliseAddress(logged.recipient) !== recipient,
    subject,
    detail,
    job,
    personId: owner.personId,
    orgId: owner.orgId,
  };
  await writeTimeline(ctx);

  // Same address, same job, already flagged and alerted today → the timeline
  // line is enough. A fresh or re-opened problem always alerts.
  if (wasOpen && await recentlyAlerted(recipient, job?.id || null)) return;

  await raiseAlert(ctx);
  await query(`UPDATE email_delivery_events SET alerted = true WHERE id = $1`, [eventId]);
}

/**
 * An email reached this address after it was flagged → clear the flag.
 * Only when the delivered email was CREATED after the last failure (so a
 * delivery to the To of the same email can't clear its CC), and never for an
 * address that this very email failed for.
 */
async function clearOnDelivery(recipient: string, event: ResendEmailEvent): Promise<void> {
  const createdAt = event.data?.created_at;
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) return;
  await query(
    `UPDATE email_address_problems
        SET resolved_at = NOW(), resolved_how = 'delivered', resolved_by = NULL, updated_at = NOW()
      WHERE email = $1
        AND resolved_at IS NULL
        AND last_seen_at < $2::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM email_delivery_events
           WHERE recipient = $1 AND provider_email_id = $3
        )`,
    [recipient, createdAt, event.data?.email_id || ''],
  );
}

/** Handle one verified event. Exported for tests. */
export async function processResendEvent(event: ResendEmailEvent, webhookId: string): Promise<void> {
  const recipients = recipientsOf(event);
  if (event.type === 'email.delivered') {
    for (const r of recipients) await clearOnDelivery(r, event);
    return;
  }
  const kind = badEventKind(event.type);
  if (!kind) return; // an event type we don't act on
  for (const r of recipients) await recordFailure(webhookId, kind, r, event);
}

// ── Webhook ──────────────────────────────────────────────────────────────

function header(req: Request, name: string): string | undefined {
  // Svix can white-label its headers as `webhook-*`; accept both.
  const v = req.headers[`svix-${name}`] ?? req.headers[`webhook-${name}`];
  return Array.isArray(v) ? v[0] : v;
}

export async function handleResendWebhook(req: Request, res: Response): Promise<void> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).send('Resend webhook not configured');
    return;
  }

  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const id = header(req, 'id');
  const ok = verifyResendSignature({
    secret,
    id,
    timestamp: header(req, 'timestamp'),
    signatureHeader: header(req, 'signature'),
    body,
  });
  if (!ok || !id) {
    console.error('[email-delivery] Resend webhook signature verification failed');
    res.status(400).send('Invalid signature');
    return;
  }

  let event: ResendEmailEvent;
  try {
    event = JSON.parse(body) as ResendEmailEvent;
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  try {
    await processResendEvent(event, id);
    res.json({ received: true });
  } catch (err) {
    // 500 → Resend retries. Recording is idempotent per (webhook id, recipient).
    console.error('[email-delivery] processing error:', err);
    res.status(500).send('processing error');
  }
}

// ── Reads + the "Mark as fixed" button ───────────────────────────────────

export interface EmailAddressProblem {
  email: string;
  problem: ProblemKind;
  detail: string | null;
  first_seen_at: string;
  last_seen_at: string;
  failed_count: number;
}

/** Open problems for these addresses (lower-cased on the way in). */
export async function getOpenProblems(emails: string[]): Promise<EmailAddressProblem[]> {
  const list = [...new Set(emails.map(normaliseAddress).filter((e) => e.includes('@')))].slice(0, 100);
  if (list.length === 0) return [];
  const r = await query(
    `SELECT email, problem, detail, first_seen_at, last_seen_at, failed_count
       FROM email_address_problems
      WHERE email = ANY($1::text[]) AND resolved_at IS NULL`,
    [list],
  );
  return r.rows as EmailAddressProblem[];
}

/** A person says the address is sorted. Returns false if nothing was open. */
export async function markProblemFixed(email: string, userId: string): Promise<boolean> {
  const r = await query(
    `UPDATE email_address_problems
        SET resolved_at = NOW(), resolved_how = 'marked_fixed', resolved_by = $2, updated_at = NOW()
      WHERE email = $1 AND resolved_at IS NULL
      RETURNING email`,
    [normaliseAddress(email), userId],
  );
  return r.rows.length > 0;
}
