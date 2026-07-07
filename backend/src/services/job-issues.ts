import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { frontendLink } from '../config/app-urls';

type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

/**
 * Shared helpers for the Job Issues / Problems register (`job_issues` +
 * `job_issue_events`). Extracted from routes/problems.ts so programmatic
 * callers — currently the vehicle-swap flow — can link/create issues and
 * log events through the same path as the UI, with one source of truth for
 * watcher seeding + notification firing.
 *
 * routes/problems.ts imports these (aliasing logIssueEvent → logEvent for
 * its existing call sites).
 */

/** Append a typed event row to an issue's audit timeline. */
export async function logIssueEvent(
  issueId: string,
  userId: string,
  eventType: string,
  body: string | null,
  metadata: Record<string, unknown> | null = null,
  opts?: { client?: DbClient },
): Promise<void> {
  const run = opts?.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);
  await run(
    `INSERT INTO job_issue_events (issue_id, event_type, body, metadata, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [issueId, eventType, body, metadata ? JSON.stringify(metadata) : null, userId],
  );
}

/**
 * Fleet-wide default watchers (migration 082). Parsed UUID array, or [] on
 * missing / invalid JSON.
 */
export async function getDefaultVehicleIssueWatchers(): Promise<string[]> {
  const raw = await getSystemSetting('vehicle_issue_default_watchers');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    console.warn('vehicle_issue_default_watchers: invalid JSON, ignoring');
    return [];
  }
}

// Severity → notification priority:
//   urgent → 'urgent' (immediate email regardless of working hours)
//   normal → 'normal' (4h escalation in working hours)
//   low    → 'low'    (bell only, no email escalation)
export function severityToPriority(severity: string | null | undefined): 'urgent' | 'normal' | 'low' {
  if (severity === 'urgent') return 'urgent';
  if (severity === 'low') return 'low';
  return 'normal';
}

/**
 * Fire inbox notifications for an issue event.
 *
 * Recipients: watchers + assignee + fleet-wide defaults (deduped), excluding
 * the actor. `includeReporter` adds the reporter — used for reflag /
 * status-change events. Best-effort: failures are logged, never thrown.
 */
export async function notifyIssueRecipients(
  issueId: string,
  actorUserId: string,
  severity: string | null | undefined,
  title: string,
  content: string,
  opts: { includeReporter?: boolean } = {},
): Promise<void> {
  try {
    const issueRow = await query(
      `SELECT ji.watchers, ji.assigned_to, ji.reported_by, ji.summary,
              j.hh_job_number
       FROM job_issues ji
       LEFT JOIN jobs j ON j.id = ji.job_id
       WHERE ji.id = $1`,
      [issueId],
    );
    if (issueRow.rowCount === 0) return;

    const row = issueRow.rows[0];
    const recipients: Set<string> = new Set();
    for (const w of (row.watchers as string[] | null) || []) recipients.add(w);
    if (row.assigned_to) recipients.add(row.assigned_to);
    if (opts.includeReporter && row.reported_by) recipients.add(row.reported_by);
    for (const w of await getDefaultVehicleIssueWatchers()) recipients.add(w);
    recipients.delete(actorUserId);

    if (recipients.size === 0) return;

    const priority = severityToPriority(severity);
    const actionUrl = `/operations/problems/${issueId}`;

    for (const userId of recipients) {
      await query(
        `INSERT INTO notifications
           (user_id, type, title, content, entity_type, entity_id, action_url, priority, source_user_id)
         VALUES ($1, 'system', $2, $3, 'job_issues', $4, $5, $6, $7)`,
        [userId, title, content, issueId, actionUrl, priority, actorUserId],
      );
    }
  } catch (err) {
    console.error('Issue notification fire failed (non-fatal):', err);
  }
}

/** Categories that mean "the van itself has a problem" — drive the direct email. */
const VEHICLE_ALERT_CATEGORIES = new Set(['damaged', 'broken', 'breakdown']);

/**
 * Direct email alert for vehicle-anchored issues (any severity).
 *
 * Closes the "van returned damaged and nobody was told" gap: the bell
 * notifications from notifyIssueRecipients depend on watcher config,
 * severity-driven escalation, and working hours — a Low-severity scratch
 * never reached anyone's inbox. This fires an immediate email via the
 * vehicle-notify convention (info@ + will@) whenever a vehicle issue in a
 * damage-shaped category is created or re-flagged, regardless of severity.
 *
 * Also stamps `email_sent_at` on the just-created bell notifications for
 * the vehicle manager so the escalation scheduler doesn't double-fire.
 *
 * Best-effort: failures are logged, never thrown.
 */
export async function sendVehicleIssueAlertEmail(
  issueId: string,
  eventVerb: 'logged' | 're-flagged' = 'logged',
): Promise<void> {
  try {
    const result = await query(
      `SELECT ji.id, ji.category, ji.severity, ji.summary, ji.description, ji.vehicle_id,
              fv.reg AS vehicle_reg,
              j.hh_job_number, j.job_name,
              COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''), u.email) AS reporter_name,
              (SELECT COUNT(*) FROM job_issue_files jif WHERE jif.issue_id = ji.id AND jif.file_type = 'photo') AS photo_count
       FROM job_issues ji
       LEFT JOIN fleet_vehicles fv ON fv.id = ji.vehicle_id
       LEFT JOIN jobs j ON j.id = ji.job_id
       LEFT JOIN users u ON u.id = ji.reported_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE ji.id = $1`,
      [issueId],
    );
    if (result.rowCount === 0) return;
    const issue = result.rows[0];

    // Only vehicle-anchored issues in damage-shaped categories.
    if (!issue.vehicle_id || !VEHICLE_ALERT_CATEGORIES.has(issue.category)) return;

    const { getVehicleNotificationTargets } = await import('./vehicle-notify');
    const targets = await getVehicleNotificationTargets();

    const emailService = (await import('./email-service')).default;
    await emailService.send('vehicle_damage_logged', {
      to: targets.to,
      cc: targets.cc,
      variables: {
        vehicleReg: issue.vehicle_reg || 'Unknown reg',
        category: issue.category,
        severity: issue.severity,
        eventVerb,
        summary: issue.summary || '',
        description: issue.description || '',
        jobRef: issue.hh_job_number
          ? `#${issue.hh_job_number}${issue.job_name ? ` (${issue.job_name})` : ''}`
          : '',
        reportedBy: issue.reporter_name || 'Unknown',
        photoLine: Number(issue.photo_count) > 0 ? `📷 ${issue.photo_count} photo(s) attached` : '',
        issueUrl: frontendLink(`/operations/problems/${issueId}`),
      },
    });

    // Direct email sent — stop the escalation scheduler re-emailing the
    // vehicle manager's bell for the same event.
    if (targets.bellUserIds.length > 0) {
      await query(
        `UPDATE notifications SET email_sent_at = NOW()
         WHERE entity_type = 'job_issues' AND entity_id = $1
           AND user_id = ANY($2) AND email_sent_at IS NULL`,
        [issueId, targets.bellUserIds],
      );
    }
  } catch (err) {
    console.error('[job-issues] Vehicle issue alert email failed (non-fatal):', err);
  }
}

/**
 * Backline requirement flagged as Problem (`status='blocked'`) → make sure
 * an open register issue exists for the job. Called from the two backline
 * status writers (requirements PATCH + backline overview PATCH).
 *
 * Dedup: one open backline-sourced issue per job. A second Problem flag
 * (e.g. status toggled away and back) appends a `reflagged` event to the
 * existing issue instead of breeding duplicates.
 *
 * Best-effort: failures are logged, never thrown — a notification hiccup
 * must not block the status change itself.
 */
export async function ensureBacklineProblemIssue(opts: {
  jobId: string;
  requirementId: string;
  phase: string | null;
  notes: string | null;
  actorUserId: string;
}): Promise<void> {
  try {
    const job = await query(
      `SELECT id, job_name, hh_job_number FROM jobs WHERE id = $1 AND is_deleted = false`,
      [opts.jobId],
    );
    if (job.rowCount === 0) return;
    const { job_name, hh_job_number } = job.rows[0];

    const phaseLabel = opts.phase === 'post_hire' ? 'de-prep' : 'prep';
    const existing = await query(
      `SELECT id FROM job_issues
       WHERE job_id = $1 AND source_module = 'backline'
         AND status NOT IN ('resolved', 'written_off', 'cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [opts.jobId],
    );

    if (existing.rowCount && existing.rowCount > 0) {
      const issueId = existing.rows[0].id;
      await logIssueEvent(issueId, opts.actorUserId, 'reflagged',
        `Backline ${phaseLabel} flagged as Problem again${opts.notes ? `: ${opts.notes.slice(0, 500)}` : ''}`,
        { source: 'backline_status', requirement_id: opts.requirementId },
      );
      await query(`UPDATE job_issues SET updated_at = NOW() WHERE id = $1`, [issueId]);
      return;
    }

    await createJobIssue({
      reportedByUserId: opts.actorUserId,
      category: 'other',
      severity: 'normal',
      summary: `Backline problem flagged on ${job_name || 'job'}${hh_job_number ? ` (#${hh_job_number})` : ''}`,
      description: `Backline ${phaseLabel} requirement marked as Problem.${opts.notes ? `\n\nRequirement notes: ${opts.notes}` : ''}`,
      sourceModule: 'backline',
      jobId: opts.jobId,
      echoToJobTimeline: true,
    });
  } catch (err) {
    console.error('[job-issues] Backline problem issue creation failed (non-fatal):', err);
  }
}

/**
 * Programmatically create a job issue (insert + 'created' event + watcher
 * seeding + notification + optional job-timeline echo). Mirrors the
 * POST /api/problems handler for non-HTTP callers like the vehicle-swap flow.
 *
 * Returns the new issue id.
 */
export async function createJobIssue(opts: {
  reportedByUserId: string;
  category: string;
  severity?: string;
  summary: string;
  description?: string | null;
  sourceModule?: string;
  jobId?: string | null;
  vehicleId?: string | null;
  driverId?: string | null;
  clientOrganisationId?: string | null;
  surfaceOn?: string | null;
  watchers?: string[];
  echoToJobTimeline?: boolean;
  client?: DbClient;
}): Promise<string> {
  const run = opts.client
    ? (text: string, params?: unknown[]) => opts.client!.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params);

  const severity = opts.severity || 'normal';
  const sourceModule = opts.sourceModule || 'vehicle';

  // Resolve client org from the job when not supplied.
  let clientOrgId: string | null = opts.clientOrganisationId ?? null;
  if (!clientOrgId && opts.jobId) {
    const job = await run(`SELECT client_id FROM jobs WHERE id = $1`, [opts.jobId]);
    clientOrgId = job.rows[0]?.client_id ?? null;
  }

  const defaultWatchers = await getDefaultVehicleIssueWatchers();
  const watchers = Array.from(new Set([...(opts.watchers ?? []), ...defaultWatchers]));

  const insert = await run(
    `INSERT INTO job_issues (
       job_id, vehicle_id, driver_id, client_organisation_id,
       category, source_module, severity, summary, description,
       reported_by, watchers, surface_on
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12
     ) RETURNING id`,
    [
      opts.jobId ?? null, opts.vehicleId ?? null, opts.driverId ?? null, clientOrgId,
      opts.category, sourceModule, severity, opts.summary, opts.description ?? null,
      opts.reportedByUserId, watchers, opts.surfaceOn ?? null,
    ],
  );
  const issueId = insert.rows[0].id;

  await logIssueEvent(issueId, opts.reportedByUserId, 'created', opts.summary, {
    category: opts.category, severity, source_module: sourceModule,
  }, { client: opts.client });

  // Notification + timeline echo run on the default pool (best-effort) so a
  // caller's transaction isn't held open on them.
  await notifyIssueRecipients(
    issueId, opts.reportedByUserId, severity,
    `New issue: ${opts.summary.slice(0, 80)}`,
    `${opts.category} — ${severity}`,
  );

  // Direct email for vehicle damage/breakdown — gated internally on
  // vehicle anchor + category. No-op inside a caller's transaction window
  // only if the row isn't committed yet; callers passing `client` should
  // be aware the email read uses the default pool.
  if (!opts.client) {
    await sendVehicleIssueAlertEmail(issueId, 'logged');
  }

  if (opts.echoToJobTimeline && opts.jobId) {
    await run(
      `INSERT INTO interactions (type, content, job_id, created_by, source)
       VALUES ('note', $1, $2, $3, 'system')`,
      [
        `⚠️ Issue logged (${opts.category}${severity === 'urgent' ? ', urgent' : ''}): ${opts.summary}`,
        opts.jobId, opts.reportedByUserId,
      ],
    );
  }

  return issueId;
}
