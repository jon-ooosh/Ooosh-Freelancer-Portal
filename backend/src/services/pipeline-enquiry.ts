/**
 * Shared pipeline enquiry creation.
 *
 * Extracted from the POST /api/pipeline/enquiry handler so that the staff
 * route AND the public website intake route (POST /api/enquiry-intake) share
 * ONE creation code path and can't drift.
 *
 * Deliberately does NOT validate job date/time ordering — that lives in
 * `validateJobDateTimes` inside routes/pipeline.ts (which is woven into the
 * HireHop-push helpers `buildHHDateTime` / `calcHHDuration`). Callers validate
 * first: the staff route keeps its existing `validateJobDateTimes` call; the
 * intake route does a light start<=end sanity check on the two dates a web
 * enquiry carries. Everything downstream of validation (job name, client
 * resolution, INSERT, timeline interaction, audit, chase-alert notification,
 * requirement seeding, job_contacts) lives here.
 *
 * This creates an OP-native enquiry ONLY. It never pushes to HireHop — that is
 * a separate, explicit staff action (POST /api/pipeline/:id/push-hirehop).
 */

import { query } from '../config/database';
import { logAudit } from '../middleware/audit';

export interface CreatePipelineEnquiryInput {
  client_name: string;
  details?: string | null;
  out_date?: string | null;
  job_date?: string | null;
  job_end?: string | null;
  return_date?: string | null;
  out_time?: string | null;
  start_time?: string | null;
  return_time?: string | null;
  end_time?: string | null;
  job_name?: string | null;
  client_id?: string | null;
  venue_id?: string | null;
  venue_name?: string | null;
  enquiry_source?: string | null;
  job_value?: number | null;
  likelihood?: 'hot' | 'warm' | 'cold' | null;
  notes?: string | null;
  manager1_person_id?: string | null;
  next_chase_date?: string | null;
  chase_interval_days?: number | null;
  chase_alert_user_id?: string | null;
  service_types?: Array<'self_drive_van' | 'backline' | 'rehearsal'> | null;
  band_name?: string | null;
  contact_person_ids?: string[] | null;
  primary_contact_person_id?: string | null;
}

export class EnquiryValidationError extends Error {}

/**
 * Create an OP-native pipeline enquiry.
 *
 * @param input   The enquiry fields (already date-validated by the caller).
 * @param actorId The user id to attribute created_by / audit / interaction to.
 *                For the website intake this is SYSTEM_USER_ID.
 * @returns the created `jobs` row.
 * @throws EnquiryValidationError when neither details nor a service type is
 *         supplied (mirrors the original 400 in the staff route).
 */
export async function createPipelineEnquiry(
  input: CreatePipelineEnquiryInput,
  actorId: string
): Promise<Record<string, unknown>> {
  const {
    client_name, out_date, job_date, job_end, return_date, job_name,
    client_id, venue_id, venue_name, enquiry_source,
    job_value, likelihood, notes, manager1_person_id,
    next_chase_date, chase_interval_days, chase_alert_user_id,
    service_types, band_name,
    contact_person_ids, primary_contact_person_id,
    out_time, start_time, return_time, end_time,
  } = input;
  let { details } = input;

  // Service type labels
  const serviceLabels: Record<string, string> = {
    self_drive_van: 'Self-drive van',
    backline: 'Backline',
    rehearsal: 'Rehearsal',
  };
  const selectionPart = service_types && service_types.length > 0
    ? service_types.map((t: string) => serviceLabels[t] || t).join(' + ')
    : null;

  // Require either details or service_types
  if (!details && !selectionPart) {
    throw new EnquiryValidationError('Please provide a description or select a service type');
  }

  // If no details text, use service type labels
  if (!details && selectionPart) {
    details = selectionPart;
  }

  // Auto-generate job name: "Band - Client - Selection" (with regular dashes)
  let finalJobName = job_name;
  if (!finalJobName) {
    const parts: string[] = [];
    if (band_name) parts.push(band_name);
    parts.push(client_name);
    if (selectionPart) parts.push(selectionPart);
    finalJobName = parts.join(' - ');
  }

  // Server-side fallback: if only client_name (no client_id) and an existing
  // organisation has that exact name, auto-link it. 0 matches → leave null
  // (text only — possibly a new client). 2+ matches → ambiguous, leave null.
  let resolvedClientId = client_id || null;
  if (!resolvedClientId && client_name) {
    const lookup = await query(
      `SELECT id FROM organisations
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND is_deleted = false
       LIMIT 2`,
      [client_name]
    );
    if (lookup.rows.length === 1) {
      resolvedClientId = lookup.rows[0].id;
    }
  }

  // Resolve manager: use provided person_id, or look up the actor's person_id.
  // (For SYSTEM_USER_ID this yields null — the system user has no person_id.)
  let managerId = manager1_person_id || null;
  if (!managerId) {
    const userResult = await query(
      `SELECT person_id FROM users WHERE id = $1`,
      [actorId]
    );
    managerId = userResult.rows[0]?.person_id || null;
  }

  const chaseIntervalDays = chase_interval_days || 3;
  const chaseDate = next_chase_date || null;
  // If no chase date given, default to interval from today
  const chaseDateSql = chaseDate
    ? `$17::date`
    : `CURRENT_DATE + ($17 || ' days')::interval`;

  const result = await query(
    `INSERT INTO jobs (
      job_name, details, out_date, job_date, job_end, return_date,
      out_time, start_time, return_time, end_time,
      client_id, client_name, company_name,
      venue_id, venue_name,
      enquiry_source, job_value, likelihood, notes,
      manager1_person_id,
      status, status_name,
      pipeline_status, pipeline_status_changed_at,
      chase_interval_days, next_chase_date,
      created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $19, $20, $21, $22,
      $7, $8, $8,
      $9, $10,
      $11, $12, $13, $14,
      $15,
      0, 'Enquiry',
      'new_enquiry', NOW(),
      $18, ${chaseDateSql},
      $16
    ) RETURNING *`,
    [
      finalJobName, details, out_date || null, job_date || null, job_end || null, return_date || null,
      resolvedClientId, client_name,
      venue_id || null, venue_name || null,
      enquiry_source || null, job_value || null, likelihood || 'warm', notes || null,
      managerId,
      actorId,
      chaseDate || String(chaseIntervalDays),
      chaseIntervalDays,
      out_time || '09:00', start_time || out_time || '09:00', return_time || '09:00', end_time || '09:00',
    ]
  );

  const jobId = result.rows[0].id as string;

  // Log creation as an interaction on the job timeline
  await query(
    `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
     VALUES ('status_transition', $1, $2, $3, 'new_enquiry', 'system')`,
    [`New enquiry created: ${finalJobName}`, jobId, actorId]
  );

  await logAudit(actorId, 'jobs', jobId, 'create', null, result.rows[0]);

  // Create chase alert notification if requested
  if (chase_alert_user_id) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, priority, action_url, source_user_id)
       VALUES ($1, 'chase_alert', $2, $3, 'jobs', $4, 'normal', $5, $6)`,
      [
        chase_alert_user_id,
        `Chase reminder: ${finalJobName}`,
        `Chase due for ${client_name} — ${finalJobName}`,
        jobId,
        `/jobs/${jobId}`,
        actorId,
      ]
    );
  }

  // Auto-create job requirements based on service type selections
  if (service_types && service_types.length > 0) {
    const requirementMap: Record<string, string[]> = {
      self_drive_van: ['vehicle', 'hire_forms', 'excess'],
      backline: ['backline'],
      rehearsal: ['rehearsal'],
    };
    const reqTypes = new Set<string>();
    for (const st of service_types) {
      const mapped = requirementMap[st];
      if (mapped) mapped.forEach(t => reqTypes.add(t));
    }
    for (const reqType of reqTypes) {
      try {
        // Check if already exists (unique constraint is deferred so ON CONFLICT won't work)
        const exists = await query(
          `SELECT 1 FROM job_requirements WHERE job_id = $1 AND requirement_type = $2 LIMIT 1`,
          [jobId, reqType]
        );
        if (exists.rows.length === 0) {
          await query(
            `INSERT INTO job_requirements (job_id, requirement_type, status, created_by, source)
             VALUES ($1, $2, 'not_started', $3, 'enquiry_form')`,
            [jobId, reqType, actorId]
          );
        }
      } catch (reqErr) {
        console.error(`Failed to create requirement ${reqType} for job ${jobId}:`, reqErr);
      }
    }
  }

  // Per-job contact selection (migration 086). Stores which people are on
  // THIS hire, with one optional primary.
  if (contact_person_ids && contact_person_ids.length > 0) {
    for (const personId of contact_person_ids) {
      try {
        const isPrimary = primary_contact_person_id === personId;
        await query(
          `INSERT INTO job_contacts (job_id, person_id, is_primary, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id, person_id) DO NOTHING`,
          [jobId, personId, isPrimary, actorId]
        );
      } catch (contactErr) {
        console.error(`Failed to link contact ${personId} to job ${jobId}:`, contactErr);
      }
    }
  }

  return result.rows[0];
}
