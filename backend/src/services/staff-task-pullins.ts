/**
 * "Mine" pull-ins — docs/TASKS-SPEC.md §2, To Do phase 4.
 *
 * The one-stop glance: my job reminders and my Problems, shown in To Do ›
 * Mine beside my to-dos. READ-THROUGH ONLY. They still live in their own
 * modules, and anything done to them goes through THOSE modules' endpoints —
 * ticking a reminder is `PATCH /requirements/:id`, a Problem is worked on its
 * own page. To Do never writes to job_requirements or job_issues: two write
 * paths to one row is the drift CLAUDE.md's helper rule exists to stop.
 */

import { query } from '../config/database';

/**
 * Job reminders that are mine: assigned to me, or created by me with nobody
 * assigned (the job remind-me form's "Me" is "nobody picked", which the
 * reminder scheduler sends to the creator — same rule here).
 *
 * Gated like every requirements reader must be (jobs-pipeline rules): not on
 * a lost / cancelled job unless explicitly kept, not a suspension marker,
 * not on a deleted job.
 */
export async function listMyJobReminders(userId: string) {
  const r = await query(
    `SELECT jr.id, jr.custom_label, jr.notes, jr.due_date::text AS due_date, jr.status, jr.phase,
            j.id AS job_id, j.hh_job_number, j.job_name, j.client_name
       FROM job_requirements jr
       JOIN jobs j ON j.id = jr.job_id AND j.is_deleted = false
      WHERE jr.requirement_type = 'reminder'
        AND jr.status NOT IN ('done', 'cancelled')
        AND (jr.assigned_to = $1 OR (jr.assigned_to IS NULL AND jr.created_by = $1))
        AND (j.pipeline_status NOT IN ('lost', 'cancelled') OR jr.keep_after_close = true)
        AND COALESCE(jr.notes, '') NOT LIKE '%[Suspended:%'
      ORDER BY jr.due_date NULLS LAST, jr.created_at`,
    [userId]
  );
  return r.rows;
}

/** Problems assigned to me that aren't closed. Worked on their own page. */
export async function listMyProblems(userId: string) {
  const r = await query(
    `SELECT i.id, i.summary, i.status, i.severity, i.category,
            j.id AS job_id, j.hh_job_number, j.job_name
       FROM job_issues i
       LEFT JOIN jobs j ON j.id = i.job_id
      WHERE i.assigned_to = $1
        AND i.status NOT IN ('resolved', 'written_off', 'cancelled')
      ORDER BY (i.severity = 'urgent') DESC, i.created_at`,
    [userId]
  );
  return r.rows;
}
