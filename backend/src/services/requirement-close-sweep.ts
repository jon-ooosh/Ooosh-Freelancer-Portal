/**
 * Lost / Cancelled requirement cleanup — the forward half.
 *
 * `requirement-cleanup.ts` reverses this on resurrection; this is the pass
 * that runs when a job dies. Three steps, and **the order is the whole
 * point** (see CLAUDE.md → "Lost / Cancelled cleanup pattern"):
 *
 *   1. flag the requirements staff chose to KEEP (`keep_after_close = true`),
 *      because step 3 skips them;
 *   2. fire any `reminder` requirement whose `event_trigger` matches this
 *      status — it notifies, emails and self-marks done;
 *   3. sweep everything else still open to `cancelled`.
 *
 * Get 2 and 3 the wrong way round and a reminder set to fire "when this job
 * is lost" is cancelled before it ever fires.
 *
 * ── Why this is a service (Sep 2026) ────────────────────────────────────
 * It was written inline in `PATCH /api/pipeline/:id/status` and, separately,
 * in `POST /api/cancellations/:jobId/process`. The two unattended paths that
 * also close jobs — the 09:00 stale-enquiry auto-loser and the HireHop
 * webhook — did neither, so an auto-lost enquiry kept its requirement cards
 * open AND any reminder set to trigger on `lost` never fired at all. The
 * transport side of that same gap is `services/job-close-cascade.ts`; this is
 * its requirements counterpart, deliberately separate because the ordering
 * constraint above doesn't apply to quotes.
 *
 * Unattended callers pass `actorUserId: null`. A triggered reminder with no
 * `assigned_to` goes to whoever CREATED it ("Me" in the reminder modal writes
 * no assignee, so the creator is the intended recipient); only a reminder with
 * neither falls back to every active admin/manager, matching the close-out
 * chase scanner's convention — the alternative is a reminder that fires into
 * nobody's inbox.
 */
import { query } from '../config/database';
import emailService from './email-service';
import { getFrontendUrl } from '../config/app-urls';
import { LOST_REQUIREMENT_MARKER, CANCELLED_REQUIREMENT_MARKER } from './requirement-cleanup';

export type RequirementCloseReason = 'lost' | 'cancelled';

/**
 * Marker text AND its separator, per reason.
 *
 * The separator matters: `requirement-cleanup.ts` strips these by exact
 * string match (`REPLACE(notes, E'\n[Auto-cancelled: job marked lost]', '')`
 * / `REPLACE(notes, ' [Cancelled]', '')`), so writing the lost marker with a
 * leading space — or the cancelled one with a newline — would leave residue
 * in `notes` on every resurrection. Mirrors exactly what the two inline
 * copies wrote.
 */
const SWEEP_MARKER: Record<RequirementCloseReason, { sep: string; text: string }> = {
  lost: { sep: '\n', text: LOST_REQUIREMENT_MARKER },
  cancelled: { sep: ' ', text: CANCELLED_REQUIREMENT_MARKER },
};

const KEEP_MARKER: Record<RequirementCloseReason, string> = {
  lost: '[Kept alive after job marked lost]',
  cancelled: '[Kept alive after job cancelled]',
};

export interface CloseJobRequirementsOptions {
  jobId: string;
  reason: RequirementCloseReason;
  /** Requirement ids staff ticked to keep alive. Absent on unattended paths. */
  keepRequirementIds?: string[] | null;
  /** Logged-in user, or null on the cron / webhook paths. */
  actorUserId?: string | null;
}

export interface CloseJobRequirementsResult {
  kept: number;
  triggersFired: number;
  swept: number;
}

/** Active admin/manager user ids — the fallback inbox for an unassigned reminder. */
async function adminFallbackUserIds(): Promise<string[]> {
  const admins = await query(
    `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`,
  );
  return admins.rows.map((r: { id: string }) => r.id);
}

/**
 * Fire the `reminder` requirements whose `event_trigger` matches `event`.
 *
 * Exported separately because `confirmed` transitions fire triggers WITHOUT
 * any sweep — a confirmed job's requirements are the work, not litter.
 *
 * Each fired reminder notifies its assignee, falling back to its creator and
 * then to every admin/manager, optionally emails per `delivery_method`, then
 * self-marks `done` so the sweep that follows can't cancel it.
 */
export async function fireEventTriggeredReminders(
  jobId: string,
  event: 'confirmed' | RequirementCloseReason,
  actorUserId: string | null,
): Promise<number> {
  const logTag = `[RequirementClose/${event}]`;
  try {
    const triggered = await query(
      `SELECT jr.id, jr.custom_label, jr.assigned_to, jr.created_by, jr.notes, jr.delivery_method, jr.job_id
       FROM job_requirements jr
       WHERE jr.job_id = $1
         AND jr.requirement_type = 'reminder'
         AND jr.event_trigger = $2
         AND jr.status NOT IN ('done', 'cancelled')`,
      [jobId, event],
    );
    if (triggered.rows.length === 0) return 0;

    const jobRow = await query(
      `SELECT job_name, client_name, hh_job_number FROM jobs WHERE id = $1`,
      [jobId],
    );
    const j = jobRow.rows[0] || {};
    const jobName = j.job_name || j.client_name || `Job ${j.hh_job_number || ''}`;

    // Only looked up if some reminder actually needs it.
    let fallbackIds: string[] | null = null;

    for (const rem of triggered.rows) {
      // Who the reminder is FOR. `assigned_to` is NULL when staff pick "Me"
      // in the reminder modal — the option writes no id, so the creator IS
      // the intended recipient. Falling straight through to `actorUserId`
      // sent "remind ME if this job is lost" to whoever happened to mark it
      // lost, and to every admin on the unattended paths. Same order the
      // hourly date-based scanner uses (config/scheduler.ts), deliberately:
      // one reminder must not mean two different people depending on which
      // route fires it.
      let targets: string[];
      if (rem.assigned_to) {
        targets = [rem.assigned_to];
      } else if (rem.created_by) {
        targets = [rem.created_by];
      } else if (actorUserId) {
        targets = [actorUserId];
      } else {
        if (fallbackIds === null) fallbackIds = await adminFallbackUserIds();
        targets = fallbackIds;
      }

      const title = `Reminder triggered: ${rem.custom_label || 'Reminder'}`;
      const eventWord = event === 'lost' ? 'lost' : event === 'cancelled' ? 'cancelled' : 'confirmed';
      const content = `Job ${eventWord} — ${rem.custom_label || 'Reminder'} (${jobName})`;
      const deliveryMethod = rem.delivery_method || 'both';
      // 'notification' → low priority (no email escalation); 'email' / 'both'
      // → high, and an immediate send below. Event triggers are time-sensitive.
      const priority = deliveryMethod === 'notification' ? 'low' : 'high';

      for (const targetUserId of targets) {
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
           VALUES ($1, 'follow_up', $2, $3, 'jobs', $4, $5, $6, $7)`,
          [targetUserId, title, content, rem.job_id, `/jobs/${rem.job_id}?tab=overview`, priority, actorUserId],
        );

        if (deliveryMethod === 'email' || deliveryMethod === 'both') {
          try {
            const userResult = await query(
              `SELECT u.email, p.first_name FROM users u
               LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
              [targetUserId],
            );
            if (userResult.rows.length > 0 && userResult.rows[0].email) {
              await emailService.sendRaw({
                to: userResult.rows[0].email,
                subject: title,
                html: `<p>Hi ${userResult.rows[0].first_name || ''},</p>
                       <p>Your reminder "<strong>${rem.custom_label || 'Reminder'}</strong>" has been triggered because the job <strong>${jobName}</strong> is now <strong>${eventWord}</strong>.</p>
                       ${rem.notes ? `<p>Notes: ${rem.notes}</p>` : ''}
                       <p><a href="${getFrontendUrl()}/jobs/${rem.job_id}?tab=overview">View Job</a></p>`,
              });
            }
          } catch (emailErr) {
            console.warn(`${logTag} Event trigger email failed:`, emailErr);
          }
        }
      }

      // Self-mark done so the sweep below leaves it alone.
      await query(
        `UPDATE job_requirements SET status = 'done', updated_at = NOW() WHERE id = $1`,
        [rem.id],
      );
    }

    console.log(`${logTag} Fired ${triggered.rows.length} event-triggered reminder(s) for job ${jobId}`);
    return triggered.rows.length;
  } catch (err) {
    console.warn(`${logTag} Event trigger check failed:`, err);
    return 0;
  }
}

/**
 * The full close pass: flag kept → fire triggers → sweep the rest.
 *
 * Idempotent (every UPDATE excludes `done` / `cancelled` rows) and never
 * throws — cleanup must not take down the status change that triggered it.
 */
export async function closeJobRequirements(
  opts: CloseJobRequirementsOptions,
): Promise<CloseJobRequirementsResult> {
  const { jobId, reason, keepRequirementIds, actorUserId = null } = opts;
  const result: CloseJobRequirementsResult = { kept: 0, triggersFired: 0, swept: 0 };
  const logTag = `[RequirementClose/${reason}]`;

  // 1. Flag the keeps FIRST — step 3 skips `keep_after_close = true`, and
  //    background scanners check the same flag so kept items keep firing even
  //    though the parent job is now terminal.
  const keepIds = Array.isArray(keepRequirementIds) ? keepRequirementIds : [];
  if (keepIds.length > 0) {
    try {
      const kept = await query(
        `UPDATE job_requirements
         SET keep_after_close = true,
             notes = COALESCE(notes, '') || $3::text,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[])
           AND job_id = $2
           AND status NOT IN ('done', 'cancelled')
         RETURNING id`,
        [keepIds, jobId, `\n${KEEP_MARKER[reason]}`],
      );
      result.kept = kept.rows.length;
    } catch (err) {
      console.warn(`${logTag} Failed to flag kept requirements:`, err);
    }
  }

  // 2. Fire matching event triggers BEFORE the sweep, or a reminder set to
  //    fire on this very status gets cancelled without ever firing.
  result.triggersFired = await fireEventTriggeredReminders(jobId, reason, actorUserId);

  // 3. Sweep everything else still open.
  try {
    const { sep, text } = SWEEP_MARKER[reason];
    const swept = await query(
      `UPDATE job_requirements
       SET status = 'cancelled',
           notes = COALESCE(notes, '') || $2::text,
           updated_at = NOW()
       WHERE job_id = $1
         AND status NOT IN ('done', 'cancelled')
         AND keep_after_close = false
       RETURNING id`,
      [jobId, `${sep}${text}`],
    );
    result.swept = swept.rows.length;
    if (swept.rows.length > 0) {
      console.log(`${logTag} Auto-cancelled ${swept.rows.length} open requirement(s) for job ${jobId}`);
    }
  } catch (err) {
    console.warn(`${logTag} Failed to sweep open requirements:`, err);
  }

  return result;
}
