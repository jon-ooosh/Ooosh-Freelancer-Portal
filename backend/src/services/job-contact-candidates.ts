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
