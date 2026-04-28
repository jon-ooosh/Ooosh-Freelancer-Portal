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
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    // Escape any HTML in values to prevent XSS in emails
    const safeValue = value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), safeValue);
  }
  return result;
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
    let bodyHtml = substituteVariables(template.body, variables);

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

      const result = await transporter.sendMail({
        from: config.smtp.from,
        to: actualRecipient,
        cc: isRedirected ? undefined : options.cc,
        subject: isRedirected ? `[TEST] ${subject}` : subject,
        html,
        attachments: mailAttachments,
      });

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

      console.error(`[Email] Failed to send "${templateId}" to ${actualRecipient}:`, errorMessage);

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
      const result = await transporter.sendMail({
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
      });

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
