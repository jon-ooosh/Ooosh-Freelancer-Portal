/**
 * Hire Form Contact Resolver
 *
 * Single source of truth for "who do we email a hire form link to" — used by
 * both the manual send button (`/api/hire-forms/email-contacts/:jobId`) and
 * the auto-email scheduler (`hire-form-auto-email.ts`).
 *
 * Pre-May 2026 the auto-emailer had its own narrower lookup (client_id org +
 * people directly linked to client_id). That missed the band-management chain
 * — e.g. a job whose `client_id` is the band's company and whose actual
 * billing/decision contact is a manager linked via `job_organisations`. The
 * auto-emailer would resolve 0 contacts, log "0/0 sent", and silently skip
 * the email forever (the daily cron only fires on the exact 10-day mark, so
 * a 0-contact day wasn't retried).
 *
 * This resolver covers all five sources the picker uses:
 *   1. Client org's own email column
 *   2. People linked to client org via person_organisation_roles
 *   3. People linked to ANY org on job_organisations (band, promoter, mgmt)
 *   4. Org-level emails on job_organisations entries
 *   5. People whose name matches `jobs.client_name` (HH contact-name fallback)
 *
 * Returns deduplicated contacts, source-tagged so callers can log/audit which
 * path resolved them.
 */
import { query } from '../config/database';

export interface ResolvedContact {
  email: string;
  name: string;
  source: string;
}

/**
 * Resolve all candidate hire-form recipients for a job. Same shape as the
 * manual picker endpoint; meant to be called from any code path that needs
 * to email contacts for a specific job.
 */
export async function resolveHireFormContacts(jobId: string): Promise<ResolvedContact[]> {
  const contacts: ResolvedContact[] = [];

  // Job + client org details
  const jobResult = await query(
    `SELECT j.client_id, j.client_name, o.email AS org_email, o.name AS org_name
     FROM jobs j
     LEFT JOIN organisations o ON o.id = j.client_id
     WHERE j.id = $1 AND j.is_deleted = false`,
    [jobId]
  );
  if (jobResult.rows.length === 0) return contacts;
  const job = jobResult.rows[0];

  // 1. Client org email
  if (job.org_email) {
    contacts.push({
      email: job.org_email,
      name: job.org_name || 'Client',
      source: 'client_org',
    });
  }

  // 2. People at the client org
  if (job.client_id) {
    const peopleResult = await query(
      `SELECT p.email, p.first_name, p.last_name
       FROM person_organisation_roles por
       JOIN people p ON p.id = por.person_id
       WHERE por.organisation_id = $1
         AND p.email IS NOT NULL AND p.email != ''
         AND p.is_deleted = false
       ORDER BY p.first_name`,
      [job.client_id]
    );
    for (const p of peopleResult.rows) {
      if (!contacts.some(c => c.email.toLowerCase() === p.email.toLowerCase())) {
        contacts.push({
          email: p.email,
          name: `${p.first_name} ${p.last_name}`.trim(),
          source: 'client_person',
        });
      }
    }
  }

  // 3. People at any org linked via job_organisations (band, promoter, mgmt)
  const joPeopleResult = await query(
    `SELECT DISTINCT p.email, p.first_name, p.last_name, jo.role AS org_role, o.name AS org_name
     FROM job_organisations jo
     JOIN organisations o ON o.id = jo.organisation_id
     JOIN person_organisation_roles por ON por.organisation_id = jo.organisation_id
     JOIN people p ON p.id = por.person_id
     WHERE jo.job_id = $1
       AND p.email IS NOT NULL AND p.email != ''
       AND p.is_deleted = false
     ORDER BY p.first_name`,
    [jobId]
  );
  for (const p of joPeopleResult.rows) {
    if (!contacts.some(c => c.email.toLowerCase() === p.email.toLowerCase())) {
      const source = p.org_role
        ? `${p.org_role}${p.org_name ? ` (${p.org_name})` : ''}`
        : 'linked_org';
      contacts.push({
        email: p.email,
        name: `${p.first_name} ${p.last_name}`.trim(),
        source,
      });
    }
  }

  // 4. Org-level emails on job_organisations entries
  const joOrgResult = await query(
    `SELECT DISTINCT o.email, o.name, jo.role
     FROM job_organisations jo
     JOIN organisations o ON o.id = jo.organisation_id
     WHERE jo.job_id = $1 AND o.email IS NOT NULL AND o.email != ''`,
    [jobId]
  );
  for (const o of joOrgResult.rows) {
    if (!contacts.some(c => c.email.toLowerCase() === o.email.toLowerCase())) {
      contacts.push({
        email: o.email,
        name: o.name || 'Organisation',
        source: o.role || 'linked_org',
      });
    }
  }

  // 5. HH contact-name match (catches sole-trader-style HH jobs where the
  // billing contact is recorded as `client_name` on the job rather than as a
  // linked person)
  if (job.client_name) {
    const contactResult = await query(
      `SELECT p.email, p.first_name, p.last_name
       FROM people p
       WHERE p.email IS NOT NULL AND p.email != ''
         AND p.is_deleted = false
         AND (p.first_name || ' ' || p.last_name) ILIKE $1
       LIMIT 5`,
      [job.client_name]
    );
    for (const p of contactResult.rows) {
      if (!contacts.some(c => c.email.toLowerCase() === p.email.toLowerCase())) {
        contacts.push({
          email: p.email,
          name: `${p.first_name} ${p.last_name}`.trim(),
          source: 'job_contact',
        });
      }
    }
  }

  return contacts;
}
