/**
 * Post-hook recovery utilities.
 *
 * Used by the fire-and-forget `setImmediate` blocks that run after a route
 * has already responded (e.g. the post-book-out chain in hire-forms.ts:
 * PDF + email, OOH info email, auto-dispatch, requirement advance, vehicle
 * requirement sync). These hooks don't have the route's HTTP response to
 * surface failure, so a transient blip — DB pool exhaustion, network
 * burp, server restart mid-flight — silently loses them. The 7 May 2026
 * RX72TKO incident saw all five post-book-out hooks die simultaneously
 * on a single Connection terminated due to connection timeout.
 *
 * Two-stage hardening:
 *   1. withHookRetry()   — wrap the hook call in 3 attempts with
 *                          exponential backoff (1s, 4s, 16s). Catches
 *                          transient failures without operator action.
 *   2. alertHookFailure() — when all retries are exhausted, write a
 *                          high-priority bell notification to admins/
 *                          managers + email info@. Means a permanent
 *                          failure surfaces in minutes instead of
 *                          "next time someone notices an email didn't
 *                          arrive".
 *
 * All consumer hooks must be IDEMPOTENT — retry semantics rely on the
 * underlying operation being safe to repeat. The current consumers all
 * have natural idempotency markers (hire_form_emailed_at, ooh_info_sent_at,
 * "skip if already at target status" guards).
 *
 * NOT a replacement for the eventual outbox pattern (see CLAUDE.md
 * "Future Enhancements" — outbox would survive server restarts and give
 * full observability). This is the cheap fix that closes 90% of the gap
 * until that work is scheduled.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

interface RetryOpts {
  attempts?: number;
  baseDelayMs?: number;
}

/**
 * Run `fn` with exponential backoff retry on failure. Returns whatever
 * `fn` returns on success, or rethrows the LAST error if all attempts
 * fail. Logs each retry attempt with the delay.
 *
 * Backoff formula: baseDelay * 4^(attempt - 1). With defaults: 1s, 4s, 16s.
 */
export async function withHookRetry<T>(
  hookLabel: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {}
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delay = baseDelayMs * Math.pow(4, attempt - 1);
        console.warn(
          `[post-hook] ${hookLabel}: attempt ${attempt}/${attempts} failed (${(err as Error).message}). Retrying in ${delay}ms.`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

interface AlertOpts {
  hookLabel: string;             // Short identifier for the hook (e.g. 'OOH info email')
  jobId?: string | null;         // OP job UUID for action_url + bell entity link
  hhJobNumber?: number | null;   // HH job number for human-readable reference
  assignmentId?: string | null;  // Assignment UUID where applicable
  error: unknown;                // The final exception after retries
  context?: string;              // Optional one-liner of additional context
}

/**
 * After a hook has exhausted its retries, surface the failure loudly:
 *   - bell notification (priority=high) to every active admin/manager
 *   - email to info@oooshtours.co.uk
 *
 * Both paths swallow their own errors so a notification failure never
 * masks the original hook error. The caller is expected to console.error
 * the original exception separately.
 */
export async function alertHookFailure(opts: AlertOpts): Promise<void> {
  const { hookLabel, jobId, hhJobNumber, assignmentId, error, context } = opts;
  const errMsg = error instanceof Error ? error.message : String(error);
  const jobRef = hhJobNumber ? `#${hhJobNumber}` : (jobId ? jobId.slice(0, 8) : 'unknown');
  const frontendUrl = getFrontendUrl();
  const actionUrl = jobId ? `/jobs/${jobId}` : null;

  // ── Bell to admins/managers ──
  try {
    const admins = await query(
      `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`
    );
    const title = `Background task failed: ${hookLabel} (job ${jobRef})`;
    const content = [
      `A post-action background task failed after ${DEFAULT_ATTEMPTS} retries.`,
      `Hook: ${hookLabel}`,
      `Job: ${jobRef}${assignmentId ? ` · assignment ${assignmentId.slice(0, 8)}` : ''}`,
      `Error: ${errMsg}`,
      context ? `Context: ${context}` : '',
      'Investigate and re-trigger manually from the Job Detail page.',
    ].filter(Boolean).join('\n');

    for (const user of admins.rows) {
      try {
        await query(
          `INSERT INTO notifications (user_id, type, priority, title, content,
                                      entity_type, entity_id, action_url)
           VALUES ($1, 'system', 'high', $2, $3, $4, $5, $6)`,
          [
            user.id,
            title,
            content,
            jobId ? 'jobs' : null,
            jobId || null,
            actionUrl,
          ]
        );
      } catch (notifErr) {
        console.warn(`[post-hook] alert bell insert failed for user ${user.id}:`, (notifErr as Error).message);
      }
    }
  } catch (err) {
    console.warn('[post-hook] alert bell query failed:', (err as Error).message);
  }

  // ── Email to info@ ──
  try {
    await emailService.sendRaw({
      to: 'info@oooshtours.co.uk',
      subject: `[OP] Background task failed: ${hookLabel} (job ${jobRef})`,
      html: `
        <p>A post-action background task failed after ${DEFAULT_ATTEMPTS} retries and was abandoned. The job state is otherwise intact — only the trailing automation was lost.</p>
        <table style="border-collapse: collapse; margin-top: 12px;">
          <tr><td style="padding: 4px 12px 4px 0;"><strong>Hook</strong></td><td>${escapeHtml(hookLabel)}</td></tr>
          <tr><td style="padding: 4px 12px 4px 0;"><strong>Job</strong></td><td>${escapeHtml(jobRef)}</td></tr>
          ${assignmentId ? `<tr><td style="padding: 4px 12px 4px 0;"><strong>Assignment</strong></td><td>${escapeHtml(assignmentId)}</td></tr>` : ''}
          <tr><td style="padding: 4px 12px 4px 0;"><strong>Error</strong></td><td><code>${escapeHtml(errMsg)}</code></td></tr>
          ${context ? `<tr><td style="padding: 4px 12px 4px 0;"><strong>Context</strong></td><td>${escapeHtml(context)}</td></tr>` : ''}
        </table>
        ${actionUrl ? `<p style="margin-top: 16px;"><a href="${frontendUrl}${actionUrl}">Open job in OP</a> to investigate and manually re-trigger.</p>` : ''}
        <p style="margin-top: 16px; color: #888; font-size: 12px;">This alert is generated by the post-hook recovery system. The bell inbox shows the same event for every admin/manager.</p>
      `,
    });
  } catch (err) {
    console.warn('[post-hook] alert email failed:', (err as Error).message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convenience wrapper: run a hook with retry, and on final failure
 * fire the alert. Original error is rethrown so the caller's
 * console.error still gets the stack trace.
 */
export async function runHookWithRecovery<T>(
  alertOpts: Omit<AlertOpts, 'error'>,
  fn: () => Promise<T>,
  retryOpts: RetryOpts = {}
): Promise<T> {
  try {
    return await withHookRetry(alertOpts.hookLabel, fn, retryOpts);
  } catch (err) {
    await alertHookFailure({ ...alertOpts, error: err });
    throw err;
  }
}
