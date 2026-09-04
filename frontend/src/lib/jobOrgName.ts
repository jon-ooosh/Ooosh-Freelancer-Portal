/**
 * Which organisation name represents a job on a list.
 *
 * ONE definition, because there are ~7 surfaces that answer this question and
 * they used to disagree — some read `client_name` first, some `company_name`
 * first, and only the pipeline card knew about the lead org. A job whose client
 * had been changed therefore showed a different name depending on which page
 * you were looking at.
 *
 * Precedence:
 *   1. lead_org_name  — the org explicitly ★'d to headline this job
 *                       (job_organisations.is_primary). Chosen, never inferred.
 *   2. client_org_name — canonical name joined from organisations via client_id.
 *   3. company_name / client_name — HireHop's raw strings, last-resort fallback
 *                       for rows the join can't resolve (no client_id linked).
 *
 * The ★ is display only: jobs.client_id stays authoritative for accounting
 * (excess ledger, Xero bucketing, cross-job credit), whichever org is starred.
 *
 * Any new surface that shows "whose job is this" MUST call this rather than
 * hand-rolling the fallback chain.
 */
export interface JobOrgNameFields {
  lead_org_name?: string | null;
  client_org_name?: string | null;
  company_name?: string | null;
  client_name?: string | null;
}

const pick = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length > 0 ? t : null;
};

/**
 * "Whose job is this" for a LIST row / pipeline card. Honours the ★ lead org.
 */
export function jobDisplayOrgName(job: JobOrgNameFields | null | undefined): string | null {
  if (!job) return null;
  return pick(job.lead_org_name) ?? jobClientName(job);
}

/**
 * "What is the CLIENT called" — deliberately ignores the ★ lead org.
 *
 * Use this anywhere the name sits alongside client_id: the Client chip, the
 * Client History panel, anything passed as clientName/clientOrgName to a child.
 * Starring a band must not relabel the client in those places — the ★ changes
 * which org headlines a LIST, never who the hire is billed to.
 */
export function jobClientName(job: JobOrgNameFields | null | undefined): string | null {
  if (!job) return null;
  return pick(job.client_org_name) ?? pick(job.company_name) ?? pick(job.client_name);
}

/** jobDisplayOrgName with a placeholder for empty rendering (default em dash). */
export function jobDisplayOrgNameOr(
  job: JobOrgNameFields | null | undefined,
  fallback = '—'
): string {
  return jobDisplayOrgName(job) ?? fallback;
}

/** jobClientName with a placeholder for empty rendering (default em dash). */
export function jobClientNameOr(
  job: JobOrgNameFields | null | undefined,
  fallback = '—'
): string {
  return jobClientName(job) ?? fallback;
}
