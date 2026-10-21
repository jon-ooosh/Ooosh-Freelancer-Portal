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
 *     pressed before, AND a To Do for each of them due today (jon, 21 Oct
 *     2026: bells get missed; To Do is where the day's work is looked at).
 *     Attended paths (a staff click) get neither — the page they are on
 *     reloads and shows the panel.
 *
 * Both retire themselves: `markOptionPromptHandled()` is called by the panel
 * once no live sibling is left (or when staff act on it) — the bells are
 * resolved and the To Dos ticked done.
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
import { ukToday } from './uk-date';
import { BELL_RULES } from './bell-rules';

export const OPTION_CONFIRMED_BELL_TYPE = 'quote_option_confirmed';
/** staff_tasks.source_type for the To Do; source_id is the CONFIRMED job. */
export const OPTION_CONFIRMED_TASK_SOURCE = 'quote_option';

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
      // login_disabled: the system@ service identity is an admin that never
      // logs in — nobody would ever see its bell or To Do.
      const fallback = await query(
        `SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true
            AND COALESCE(login_disabled, false) = false`,
      );
      recipients = fallback.rows.map((r) => r.id);
    }

    const title = `Option ${job.option_no} confirmed — ${siblings.length} other option${siblings.length === 1 ? '' : 's'} still open`;
    const content = `${job.job_name || 'Job'}${job.hh_job_number ? ` (#${job.hh_job_number})` : ''} confirmed via ${sourceLabel(opts.source)}. Still open: ${list}. Open the job to mark them lost as "Confirmed Alternative Quote (from us)".`;
    const actionUrl = `${getFrontendUrl()}/jobs/${jobId}?group_prompt=1`;
    for (const userId of recipients) {
      // One live bell per user per job — a second unattended confirmation
      // event (a retried webhook, say) must not stack them. Every parameter is
      // cast: $1, $2 and $5 appear twice, and an uncast one is typed text in
      // the SELECT and varchar in the WHERE — Postgres refused the whole
      // statement (42P08), so until 21 Oct 2026 this bell was never created.
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority, resolve_key)
         SELECT $1::uuid, $2::varchar, $3::varchar, $4::text, 'jobs', $5::uuid, $6::text, 'normal', 'option_siblings_open'
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
             WHERE user_id = $1::uuid AND type = $2::varchar AND entity_id = $5::uuid AND is_read = false
          )`,
        [userId, OPTION_CONFIRMED_BELL_TYPE, title, content, jobId, actionUrl],
      ).catch((e) => console.error('[options] confirm bell failed:', e));
    }

    // …and a To Do each, due today, linking to the same place (staff-tasks.ts
    // SELECT_TASKS builds the link from the source). One open To Do per person
    // per job, for the same reason as the bells. No setter: the system raised it.
    const today = ukToday();
    const todoTitle = `Mark the other options lost? ${job.job_name || 'Job'}${job.hh_job_number ? ` (#${job.hh_job_number})` : ''}`;
    await query(
      `INSERT INTO staff_tasks (person_id, title, detail, due_date, next_chase_date, source_type, source_id)
       SELECT DISTINCT u.person_id, $2::text, $3::text, $4::date, $4::date, $5::varchar, $6::uuid
         FROM users u
        WHERE u.id = ANY($1::uuid[]) AND u.person_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM staff_tasks t
             WHERE t.person_id = u.person_id AND t.source_type = $5::varchar
               AND t.source_id = $6::uuid AND t.status = 'open'
          )`,
      [recipients, todoTitle.slice(0, 300), `${title}. ${content}`, today, OPTION_CONFIRMED_TASK_SOURCE, jobId],
    ).catch((e) => console.error('[options] confirm To Do failed:', e));
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
  // The To Dos raised alongside the bells are done too.
  await query(
    `UPDATE staff_tasks SET status = 'done', completed_at = NOW(), updated_at = NOW()
      WHERE source_type = $1 AND status = 'open'
        AND source_id IN (SELECT id FROM jobs WHERE group_id = $2)`,
    [OPTION_CONFIRMED_TASK_SOURCE, groupId],
  ).catch((e) => console.error('[options] could not tick the confirm To Dos:', e));
  return retired;
}

/**
 * The To Do twin of the 5-minute bell sweep: an open "mark the other options
 * lost?" To Do is done once its bell's rule says nothing is waiting — e.g. the
 * siblings were marked lost one by one from the Lost modal, which never calls
 * markOptionPromptHandled(). The test IS the bell's (bell-rules.ts
 * option_siblings_open), read against the To Do's job, so the two can't
 * disagree. Runs on the bell sweep's schedule (config/scheduler.ts).
 */
export async function closeDoneOptionTodos(): Promise<number> {
  const stillWaiting = BELL_RULES.option_siblings_open.stillWaiting.replace(/\bn\.entity_id\b/g, 't.source_id');
  const r = await query(
    `UPDATE staff_tasks t SET status = 'done', completed_at = NOW(), updated_at = NOW()
      WHERE t.source_type = $1 AND t.status = 'open'
        AND NOT (${stillWaiting})`,
    [OPTION_CONFIRMED_TASK_SOURCE],
  );
  return r.rowCount ?? 0;
}

function sourceLabel(s: 'pipeline' | 'payment_portal' | 'hirehop_webhook' | 'record_payment'): string {
  switch (s) {
    case 'payment_portal': return 'the payment portal';
    case 'hirehop_webhook': return 'HireHop';
    case 'record_payment': return 'a recorded payment';
    default: return 'OP';
  }
}
