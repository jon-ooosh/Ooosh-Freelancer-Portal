/**
 * Centralised Email Service
 *
 * Handles all outbound email for the Ooosh Operations Platform.
 * - Google Workspace SMTP via nodemailer
 * - Test mode: redirects ALL emails to a single address with banner
 * - Template registry with {{variable}} substitution
 * - Branded HTML layouts (client-facing and internal)
 * - Audit trail: every email logged to email_log table
 *
 * Usage:
 *   import { emailService } from '../services/email-service';
 *   await emailService.send('booking_confirmation', {
 *     to: 'client@example.com',
 *     variables: { clientName: 'John', jobNumber: 'J-1234' },
 *   });
 */
import nodemailer from 'nodemailer';
import { query } from '../config/database';
import { wrapInBaseLayout, testModeBanner } from './email-templates/base';
import templates from './email-templates/index';

// ── Types ────────────────────────────────────────────────────────────────

export type EmailMode = 'test' | 'live';

export interface EmailAttachment {
  /** Filename to display */
  filename: string;
  /** File content as Buffer */
  content: Buffer;
  /** MIME type */
  contentType: string;
}

export interface SendEmailOptions {
  /** Recipient email address */
  to: string;
  /** Template variables for substitution */
  variables?: Record<string, string>;
  /** Optional CC addresses */
  cc?: string[];
  /** Optional override subject (bypasses template subject) */
  subjectOverride?: string;
  /** Optional file attachments */
  attachments?: EmailAttachment[];
  /** Optional HTML snippet prepended to the body (after the test-mode banner if in test mode).
   *  Used by senders to inject contextual banners like "no client email on file — redirected to info@". */
  prependBanner?: string;
  /** Optional pre-rendered HTML body. Bypasses template body + variable
   *  substitution (which HTML-escapes values). Use this when the caller
   *  wants to render the body itself — e.g. the pre-hire briefing builds
   *  HTML from structured data. Template registration still controls
   *  variant + preheader + EMAIL_LIVE_TEMPLATES allowlist + audit log. */
  bodyHtmlOverride?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  logId?: string;
  redirectedTo?: string;
}

// ── Configuration ────────────────────────────────────────────────────────

function getEmailConfig() {
  const liveTemplatesRaw = process.env.EMAIL_LIVE_TEMPLATES || '';
  const liveTemplates = new Set(
    liveTemplatesRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
  return {
    mode: (process.env.EMAIL_MODE || 'test') as EmailMode,
    testRedirect: process.env.EMAIL_TEST_REDIRECT || '',
    /**
     * Per-template "go live" allowlist. Used while EMAIL_MODE=test to release
     * specific templates to real recipients (no banner, no [TEST] subject, CCs
     * honoured) without flipping the whole system live. Ignored when
     * EMAIL_MODE=live (every template goes live).
     *
     * Set in env as a comma-separated list of template IDs, e.g.
     *   EMAIL_LIVE_TEMPLATES=booking_confirmed_deposit,payment_received,...
     *
     * sendRaw() is NOT covered by this allowlist (no template ID to match).
     */
    liveTemplates,
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.SMTP_FROM || 'Ooosh Tours <notifications@oooshtours.co.uk>',
    },
  };
}

/**
 * Decide whether a specific send goes out live (real recipient, no banner)
 * vs. gets redirected to the test inbox. EMAIL_MODE=live always wins;
 * otherwise the per-template allowlist is consulted.
 */
function isTemplateGoingLive(templateId: string, config: ReturnType<typeof getEmailConfig>): boolean {
  if (config.mode === 'live') return true;
  return config.liveTemplates.has(templateId);
}

// ── Variable Substitution ────────────────────────────────────────────────

function substituteVariables(template: string, variables: Record<string, string>): string {
  // 1. Resolve {{#if varName}}...{{/if}} blocks first. The block renders iff
  // the variable is present and non-empty (after trimming). Lets templates
  // own their HTML structure while still keeping data values escaped.
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, body: string) => {
      const value = variables[key];
      return value && value.trim() !== '' ? body : '';
    }
  );

  // 2. Substitute remaining {{var}} with HTML-escaped values (XSS-safe).
  for (const [key, value] of Object.entries(variables)) {
    const safeValue = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), safeValue);
  }
  return result;
}

// ── Transient-error retry ─────────────────────────────────────────────────

/**
 * Gmail SMTP on port 587 sporadically rejects auth on a fresh STARTTLS
 * connection with `535-5.7.8 Username and Password not accepted` even when the
 * credentials are valid — a well-known flaky behaviour when every send opens a
 * brand-new authenticated connection (which we do; no pooling). It also throws
 * connection/timeout errors under load. These are all transient: a retry a few
 * seconds later almost always succeeds. Distinguish these from PERMANENT
 * failures (bad recipient 550, message rejected) which must NOT be retried.
 *
 * Proven live 8 Jul 2026 (job 16251): same info@ account, same credentials,
 * two 535s minutes apart while other sends went through fine.
 *
 * NOTE: we treat 535 as transient here on the deliberate assumption that the
 * app password is valid (verified). If the password is ever genuinely revoked,
 * every send will fail all retries and the outage canary (below) will surface
 * it — so a truly-dead password is still caught, just after the retries.
 */
function isTransientSmtpError(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string; message?: string } | undefined;
  if (!e) return false;

  // SMTP response codes: 421 (service unavailable), 45x (temp failures),
  // and 535 (Gmail's flaky-auth — treated as transient per note above).
  const rc = e.responseCode;
  if (rc === 421 || rc === 535 || (rc !== undefined && rc >= 450 && rc < 460)) return true;

  // Socket / connection level failures.
  const code = e.code;
  if (code && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EAI_AGAIN', 'EDNS', 'ETLS'].includes(code)) {
    return true;
  }

  // Fallback: match on Gmail's auth-rejection message (some nodemailer paths
  // surface the 535 in the message without a numeric responseCode).
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('username and password not accepted') || msg.includes('badcredentials') || msg.includes('invalid login')) {
    return true;
  }

  return false;
}

const RETRY_BACKOFF_MS = [2000, 5000]; // 3 attempts total: immediate, +2s, +5s

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send with retry-on-transient. Returns the nodemailer result, or throws the
 * LAST error if all attempts fail. Permanent errors throw immediately (no retry).
 */
async function sendMailWithRetry(
  transporter: nodemailer.Transporter,
  mailOptions: Parameters<nodemailer.Transporter['sendMail']>[0],
  label: string,
): Promise<{ messageId?: string }> {
  let lastErr: unknown;
  const maxAttempts = RETRY_BACKOFF_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastErr = err;
      if (!isTransientSmtpError(err) || attempt === maxAttempts) throw err;
      const waitMs = RETRY_BACKOFF_MS[attempt - 1];
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Email] Transient send failure for ${label} (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms: ${msg}`);
      await sleep(waitMs);
    }
  }
  throw lastErr; // unreachable, but satisfies the type checker
}

/**
 * SMTP-INDEPENDENT outage canary. When a send fails AFTER all retries, drop a
 * bell notification into the admin inbox (DB-backed — does NOT depend on email,
 * which is the whole point). Deduped to at most one per hour so a burst / total
 * outage produces a single loud signal, not dozens.
 *
 * This is the answer to "if email genuinely broke, how would we know?" — the
 * failure alert must not travel over the channel that's failing.
 *
 * `email_sent_at` is stamped so the notification-escalation scheduler never
 * tries to *email* this alert (it would fail too, and pointlessly).
 */
async function raiseEmailHealthAlert(templateId: string, recipient: string, errorMessage: string): Promise<void> {
  try {
    const recent = await query(
      `SELECT 1 FROM notifications
       WHERE type = 'system' AND title = 'Email delivery is failing'
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
    );
    if (recent.rows.length > 0) return; // already alerted within the last hour

    const admins = await query(`SELECT id FROM users WHERE role = 'admin' AND is_active = true`);
    if (admins.rows.length === 0) return;

    const content =
      `An email ("${templateId}" to ${recipient}) failed to send after retries: ${errorMessage}. ` +
      `Outbound email may be down — check SMTP credentials / Google Workspace. ` +
      `Further email failures in the next hour are suppressed to avoid noise.`;

    for (const a of admins.rows) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, priority, action_url, email_sent_at)
         VALUES ($1, 'system', 'Email delivery is failing', $2, 'urgent', '/settings', NOW())`,
        [a.id, content],
      );
    }
    console.warn(`[Email] Raised email-health bell alert to ${admins.rows.length} admin(s)`);
  } catch (err) {
    console.error('[Email] Failed to raise email-health canary:', err instanceof Error ? err.message : err);
  }
}

// ── Email Service Class ──────────────────────────────────────────────────

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  /**
   * Get or create the nodemailer transport.
   * Lazy-initialized so it doesn't fail on import if SMTP vars aren't set.
   */
  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;

    const config = getEmailConfig();

    if (!config.smtp.user || !config.smtp.pass) {
      throw new Error('SMTP credentials not configured. Set SMTP_USER and SMTP_PASS in .env');
    }

    this.transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });

    return this.transporter;
  }

  /**
   * Send an email using a registered template.
   */
  async send(templateId: string, options: SendEmailOptions): Promise<SendEmailResult> {
    const config = getEmailConfig();
    const template = templates[templateId];

    if (!template) {
      return { success: false, error: `Unknown email template: ${templateId}` };
    }

    const variables = options.variables || {};

    // Build subject and body from template
    const subject = options.subjectOverride || substituteVariables(template.subject, variables);
    let bodyHtml = options.bodyHtmlOverride !== undefined
      ? options.bodyHtmlOverride
      : substituteVariables(template.body, variables);

    // Decide whether THIS template is going live or being redirected.
    // EMAIL_MODE=live → always live. EMAIL_MODE=test → live only if the
    // template ID is on the EMAIL_LIVE_TEMPLATES allowlist.
    const goingLive = isTemplateGoingLive(templateId, config);
    const isRedirected = !goingLive && !!config.testRedirect;
    const actualRecipient = isRedirected ? config.testRedirect : options.to;

    if (options.prependBanner) {
      bodyHtml = options.prependBanner + bodyHtml;
    }
    if (isRedirected) {
      bodyHtml = testModeBanner(options.to) + bodyHtml;
    }

    // Wrap in base layout
    const html = wrapInBaseLayout(bodyHtml, {
      variant: template.variant,
      preheader: template.preheader ? substituteVariables(template.preheader, variables) : undefined,
    });

    // Send
    try {
      const transporter = this.getTransporter();
      const mailAttachments = options.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      }));

      const result = await sendMailWithRetry(transporter, {
        from: config.smtp.from,
        to: actualRecipient,
        cc: isRedirected ? undefined : options.cc,
        subject: isRedirected ? `[TEST] ${subject}` : subject,
        html,
        attachments: mailAttachments,
      }, `"${templateId}" to ${actualRecipient}`);

      // Log per-message effective routing, not the env-level mode. A test-mode
      // env where THIS template was allowlisted should log as 'live' so the
      // audit trail reflects what really happened.
      const effectiveMode: EmailMode = isRedirected ? 'test' : 'live';
      const logId = await this.logEmail({
        template_id: templateId,
        recipient: options.to,
        actual_recipient: actualRecipient,
        subject,
        status: 'sent',
        message_id: result.messageId || null,
        mode: effectiveMode,
      });

      console.log(`[Email] Sent "${templateId}" to ${actualRecipient}${isRedirected ? ` (test mode, intended: ${options.to})` : goingLive && config.mode === 'test' ? ' (live via allowlist)' : ''}`);

      return {
        success: true,
        messageId: result.messageId,
        logId,
        redirectedTo: isRedirected ? actualRecipient : undefined,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Log failure
      await this.logEmail({
        template_id: templateId,
        recipient: options.to,
        actual_recipient: actualRecipient,
        subject,
        status: 'failed',
        error_message: errorMessage,
        mode: isRedirected ? 'test' : 'live',
      });

      console.error(`[Email] Failed to send "${templateId}" to ${actualRecipient} (after retries):`, errorMessage);

      // SMTP-independent outage canary — bell the admin inbox so a genuine
      // email outage surfaces even though email itself is down.
      await raiseEmailHealthAlert(templateId, actualRecipient, errorMessage);

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send a raw email without a template (for one-off or custom emails).
   */
  async sendRaw(options: {
    to: string;
    subject: string;
    html: string;
    cc?: string[];
    variant?: 'client' | 'internal';
    attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  }): Promise<SendEmailResult> {
    const config = getEmailConfig();
    const isTestMode = config.mode === 'test';
    const actualRecipient = isTestMode && config.testRedirect
      ? config.testRedirect
      : options.to;

    let bodyHtml = options.html;
    if (isTestMode) {
      bodyHtml = testModeBanner(options.to) + bodyHtml;
    }

    const html = wrapInBaseLayout(bodyHtml, { variant: options.variant || 'internal' });

    try {
      const transporter = this.getTransporter();
      const result = await sendMailWithRetry(transporter, {
        from: config.smtp.from,
        to: actualRecipient,
        cc: isTestMode ? undefined : options.cc,
        subject: isTestMode ? `[TEST] ${options.subject}` : options.subject,
        html,
        attachments: options.attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      }, `raw "${options.subject}" to ${actualRecipient}`);

      await this.logEmail({
        template_id: '_raw',
        recipient: options.to,
        actual_recipient: actualRecipient,
        subject: options.subject,
        status: 'sent',
        message_id: result.messageId || null,
        mode: config.mode,
      });

      return { success: true, messageId: result.messageId };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.logEmail({
        template_id: '_raw',
        recipient: options.to,
        actual_recipient: actualRecipient,
        subject: options.subject,
        status: 'failed',
        error_message: errorMessage,
        mode: config.mode,
      });

      // SMTP-independent outage canary (see send()).
      await raiseEmailHealthAlert('_raw', actualRecipient, errorMessage);

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get current email mode.
   */
  getMode(): EmailMode {
    return getEmailConfig().mode;
  }

  /**
   * Check if SMTP is configured.
   */
  isConfigured(): boolean {
    const config = getEmailConfig();
    return !!(config.smtp.user && config.smtp.pass);
  }

  /**
   * Get list of available template IDs.
   */
  getTemplateIds(): string[] {
    return Object.keys(templates);
  }

  /**
   * Verify SMTP connection (useful for health checks / settings page).
   */
  async verifyConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const transporter = this.getTransporter();
      await transporter.verify();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Reset transporter (useful when env vars change at runtime).
   */
  resetTransporter(): void {
    this.transporter = null;
  }

  // ── Audit Log ────────────────────────────────────────────────────────

  private async logEmail(entry: {
    template_id: string;
    recipient: string;
    actual_recipient: string;
    subject: string;
    status: 'sent' | 'failed';
    message_id?: string | null;
    error_message?: string;
    mode: EmailMode;
  }): Promise<string | undefined> {
    try {
      const result = await query(
        `INSERT INTO email_log (template_id, recipient, actual_recipient, subject, status, message_id, error_message, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          entry.template_id,
          entry.recipient,
          entry.actual_recipient,
          entry.subject,
          entry.status,
          entry.message_id || null,
          entry.error_message || null,
          entry.mode,
        ],
      );
      return result.rows[0]?.id;
    } catch (err) {
      // Don't fail the email send if logging fails (table might not exist yet)
      console.warn('[Email] Failed to log email to audit trail:', err instanceof Error ? err.message : err);
      return undefined;
    }
  }
}

// ── Singleton Export ──────────────────────────────────────────────────────

export const emailService = new EmailService();
export default emailService;
