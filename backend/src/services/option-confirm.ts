/**
 * Quote options — what happens when ONE option of an enquiry confirms
 * (docs/QUOTE-VERSIONS-SPEC.md §7).
 *
 * Never auto-lose. A human marks the siblings lost from the Confirm panel on
 * Job Detail (the bar shows it whenever a confirmed job still has live, open
 * siblings). This hook's job is to make sure somebody SEES that panel:
 *
 *   - every path: a timeline note on the confirmed job naming the still-open
 *     options, so the record says the question was raised;
 *   - unattended paths (the payment portal, the HireHop webhook, the Wise
 *     matcher): a bell to the job's managers, deep-linked to the job with
 *     `?group_prompt=1` so the panel opens even if "keep them open" was
 *     pressed before. Attended paths (a staff click) get no bell — the page
 *     they are on reloads and shows the panel.
 *
 * The bells retire themselves: `markOptionPromptHandled()` is called by the
 * panel once no live sibling is left (or when staff act on it).
 *
 * Four confirmation entry points call `afterOptionConfirmed()`: the pipeline
 * status PATCH, the portal's payment-event, the HireHop webhook and
 * record-payment (staff click + Wise matcher). All four are fire-and-forget
 * from the caller's point of view — this never throws.
 */
import { query } from '../config/database';
import { getFrontendUrl } from '../config/app-urls';
import { liveSiblingOptions, noteOnTimeline } from './job-groups';
import { resolveActionBells } from './notification-resolve';

export const OPTION_CONFIRMED_BELL_TYPE = 'quote_option_confirmed';

export async function afterOptionConfirmed(
  jobId: string,
  opts: { actorUserId: string | null; source: 'pipeline' | 'payment_portal' | 'hirehop_webhook' | 'record_payment' },
): Promise<void> {
  try {
    const siblings = await liveSiblingOptions(jobId);
    if (siblings.length === 0) return;

    const jobRes = await query(
      `SELECT id, hh_job_number, job_name, option_no, option_label, group_id, pipeline_status,
              manager1_person_id, manager2_person_id
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    const job = jobRes.rows[0];
    if (!job?.group_id) return;

    const list = siblings.map((s) => `Option ${s.option_no}${s.option_label ? ` (${s.option_label})` : ''}`).join(', ');
    await noteOnTimeline(
      null,
      jobId,
      `Confirmed as Option ${job.option_no} — ${siblings.length} other option${siblings.length === 1 ? ' is' : 's are'} still open: ${list}. Mark them lost from the options bar.`,
      opts.actorUserId,
      job.pipeline_status,
    );

    // Attended: the person who confirmed it is looking at the page. No bell.
    if (opts.actorUserId) return;

    // Unattended: bell the job's managers (users with that person_id); fall back
    // to the admins + managers when the job has no manager linked to a login.
    const managerUsers = await query(
      `SELECT DISTINCT u.id FROM users u
        WHERE u.is_active = true
          AND u.person_id IS NOT NULL
          AND u.person_id IN ($1::uuid, $2::uuid)`,
      [job.manager1_person_id, job.manager2_person_id],
    );
    let recipients: string[] = managerUsers.rows.map((r) => r.id);
    if (recipients.length === 0) {
      const fallback = await query(`SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`);
      recipients = fallback.rows.map((r) => r.id);
    }

    const title = `Option ${job.option_no} confirmed — ${siblings.length} other option${siblings.length === 1 ? '' : 's'} still open`;
    const content = `${job.job_name || 'Job'}${job.hh_job_number ? ` (#${job.hh_job_number})` : ''} confirmed via ${sourceLabel(opts.source)}. Still open: ${list}. Open the job to mark them lost as "Confirmed Alternative Quote (from us)".`;
    const actionUrl = `${getFrontendUrl()}/jobs/${jobId}?group_prompt=1`;
    for (const userId of recipients) {
      // One live bell per user per job — a second unattended confirmation
      // event (a retried webhook, say) must not stack them.
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, resolve_key)
         SELECT $1, $2, $3, $4, 'jobs', $5, $6, 'normal', 'option_siblings_open'
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
             WHERE user_id = $1 AND type = $2 AND entity_id = $5 AND is_read = false
          )`,
        [userId, OPTION_CONFIRMED_BELL_TYPE, title, content, jobId, actionUrl],
      ).catch((e) => console.error('[options] confirm bell failed:', e));
    }
  } catch (err) {
    console.error('[options] afterOptionConfirmed failed (non-fatal):', err);
  }
}

/**
 * The bells for this group's confirmation prompt are done with — read AND
 * done for everyone, and open bells refresh (notification-resolve.ts). Until
 * Oct 2026 this only marked them read. The 5-minute sweep also retires them
 * once no other option is live (bell-rules.ts option_siblings_open).
 */
export async function markOptionPromptHandled(groupId: string): Promise<number> {
  const jobs = await query(`SELECT id FROM jobs WHERE group_id = $1`, [groupId]);
  let retired = 0;
  for (const j of jobs.rows) {
    retired += await resolveActionBells({ entityType: 'jobs', entityId: j.id as string, type: OPTION_CONFIRMED_BELL_TYPE });
  }
  return retired;
}

function sourceLabel(s: 'pipeline' | 'payment_portal' | 'hirehop_webhook' | 'record_payment'): string {
  switch (s) {
    case 'payment_portal': return 'the payment portal';
    case 'hirehop_webhook': return 'HireHop';
    case 'record_payment': return 'a recorded payment';
    default: return 'OP';
  }
}
