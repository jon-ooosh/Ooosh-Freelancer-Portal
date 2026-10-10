/**
 * "Who could we contact on this job?" — THE candidate pool.
 *
 * Every person reachable through a job's organisations: the client org itself
 * plus anything linked via `job_organisations` (band, management, promoter).
 * Deduped per person, with the client org's people first and each org's
 * primary contact ahead of the generals.
 *
 * Extracted from `GET /api/pipeline/:jobId/contacts` (Sep 2026) when the
 * transport-contact picker needed the same list. Two copies of this query
 * would have drifted the moment someone added a source — which is exactly
 * what happened to the hire-form contact resolver before
 * `hire-form-contacts.ts` existed.
 *
 * ── Related but NOT the same thing ──────────────────────────────────────
 * - `job_contacts` (migration 086) — who is on this HIRE. Drives CLIENT email
 *   routing: hire forms, booking confirmations, receipts.
 * - `quote_contacts` (migration 223) — who to CALL on one transport leg.
 *   Reaches freelancers through the portal, never the client email chain.
 * - `services/hire-form-contacts.ts` — who to EMAIL a hire form to. Wider
 *   still: it also pulls org-level email columns and a name match against
 *   `jobs.client_name`, because an email address with no person behind it is
 *   still a valid recipient.
 *
 * All three share this pool and diverge in what they do with it. A contact
 * ticked onto a delivery must never start receiving hire-form requests, so
 * nothing here writes to any of those tables.
 */
import { query } from '../config/database';

export interface JobContactCandidate {
  person_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  role: string | null;
  is_org_primary: boolean;
  source_org_id: string | null;
  source_org_name: string | null;
}

/**
 * Candidate contacts for a job, in priority order.
 *
 * Unlike the hire-form resolver this does NOT filter on having an email:
 * a transport contact is somebody the driver PHONES, and plenty of useful
 * site contacts have a mobile and no address on file. Callers that need an
 * email (the hire-form picker) filter for themselves.
 */
export async function resolveJobContactCandidates(
  jobId: string,
): Promise<JobContactCandidate[]> {
  // DISTINCT ON (p.id) keeps the first source per person, sorted so the client
  // org wins over linked orgs and primary contacts surface ahead of generals.
  const result = await query(
    `SELECT DISTINCT ON (p.id)
            p.id AS person_id,
            p.first_name, p.last_name, p.email, p.phone, p.mobile,
            por.role, por.is_primary AS is_org_primary,
            o.id AS source_org_id, o.name AS source_org_name,
            CASE WHEN o.id = j.client_id THEN 0 ELSE 1 END AS source_priority
     FROM jobs j
     JOIN person_organisation_roles por ON por.status = 'active'
     JOIN organisations o ON o.id = por.organisation_id AND o.is_deleted = false
     JOIN people p ON p.id = por.person_id AND p.is_deleted = false
     WHERE j.id = $1
       AND (
         o.id = j.client_id
         OR o.id IN (SELECT organisation_id FROM job_organisations WHERE job_id = j.id)
       )
     ORDER BY p.id, source_priority, por.is_primary DESC`,
    [jobId],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    person_id: r.person_id as string,
    name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    email: (r.email as string) || null,
    phone: (r.phone as string) || null,
    mobile: (r.mobile as string) || null,
    role: (r.role as string) || null,
    is_org_primary: !!r.is_org_primary,
    source_org_id: (r.source_org_id as string) || null,
    source_org_name: (r.source_org_name as string) || null,
  }));
}

/** One person a delivery note / collection confirmation could be emailed to. */
export interface JobEmailContact {
  personId: string;
  name: string;
  email: string;
  phone: string | null;
  role: string | null;
  /** The job's lead contact (`job_contacts.is_primary`) */
  isPrimary: boolean;
}

/**
 * "Who should this delivery note go to?" — the picker list shared by the
 * warehouse collection page and the freelancer portal's completion page.
 * The people ticked onto THIS hire (`job_contacts`, lead first) come first,
 * then the wider org pool from resolveJobContactCandidates() — mirroring the
 * Job Detail contacts card. Deduped per person (a ticked job contact wins
 * over the same person surfacing as an org candidate); nameless rows dropped. Rows without an email are kept (the
 * warehouse picks the collector's NAME from this list too) — callers that
 * only want addressable people filter on `email`.
 *
 * Lifted out of routes/warehouse.ts (Oct 2026) when the portal needed the
 * same list, so the two pickers cannot drift.
 */
export async function resolveJobEmailContacts(jobId: string): Promise<JobEmailContact[]> {
  const ticked = await query(
    `SELECT jc.person_id, jc.is_primary, jc.role_override,
            p.first_name, p.last_name, p.email, p.phone
     FROM job_contacts jc
     JOIN people p ON p.id = jc.person_id AND p.is_deleted = false
     WHERE jc.job_id = $1
     ORDER BY jc.is_primary DESC, p.first_name ASC`,
    [jobId],
  );
  const candidates = await resolveJobContactCandidates(jobId);

  const seen = new Set<string>();
  const contacts: JobEmailContact[] = [];
  for (const r of ticked.rows as Array<Record<string, any>>) {
    if (seen.has(r.person_id)) continue;
    seen.add(r.person_id);
    contacts.push({
      personId: r.person_id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email || '',
      phone: r.phone || null,
      role: r.role_override || null,
      isPrimary: !!r.is_primary,
    });
  }
  for (const c of candidates) {
    if (seen.has(c.person_id)) continue;
    seen.add(c.person_id);
    contacts.push({
      personId: c.person_id,
      name: c.name,
      email: c.email || '',
      phone: c.phone,
      role: c.role,
      isPrimary: false,
    });
  }
  return contacts.filter((c) => c.name);
}
