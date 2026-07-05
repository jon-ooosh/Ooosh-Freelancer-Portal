/**
 * Email → Job matcher (Auto-Chase Phase 1)
 *
 * Given a parsed inbound email, decide which OP job (if any) it belongs to.
 * Deterministic layers only in this foundation slice — the AI fuzzy layer
 * (Haiku, spec §5.3 layer 4) is a follow-up. Anything the deterministic
 * layers can't confidently attach returns `null`, and the ingestion service
 * drops it into the gmail_unmatched_inbound review queue rather than
 * guess-attaching (spec §5.3 layer 5).
 *
 * Match priority (spec §5.3):
 *   1. HH job number in an attached PDF filename (HireHop quote PDFs carry the
 *      job number in the filename — the strongest signal, same key the old
 *      Zapier flow used).
 *   2. HH job number in the subject or body (regex, validated against
 *      jobs.hh_job_number).
 *   3. Sender/recipient email → person → their org's open job.
 *   4. (follow-up) AI fuzzy match over a candidate shortlist.
 *
 * All matching is scoped to non-deleted jobs. When a job-number match resolves
 * to multiple rows (shouldn't happen — hh_job_number is effectively unique per
 * live job) we take the most recently updated. The person→job layer only fires
 * when it resolves to exactly ONE open job for that client, to avoid
 * mis-attaching a thread to the wrong hire.
 */
import { query } from '../config/database';

export interface ParsedEmailForMatch {
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  /** Filenames of attachments (used for the PDF-job-number layer). */
  attachmentFilenames: string[];
}

export type EmailMatchMethod =
  | 'pdf_filename_job_number'
  | 'subject_body_job_number'
  | 'sender_person_single_open_job';

export interface EmailMatchResult {
  jobId: string;
  hhJobNumber: number | null;
  method: EmailMatchMethod;
  confidence: 'high' | 'medium';
}

// HireHop job numbers are 4–5 digit integers. Optional leading '#'. We extract
// candidates then validate each against jobs.hh_job_number, so a stray 5-digit
// number that isn't a real job simply doesn't match.
const JOB_NUMBER_RE = /#?\b(\d{4,5})\b/g;

/** Pull every plausible job-number candidate from a blob of text. */
function extractJobNumberCandidates(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const m of text.matchAll(JOB_NUMBER_RE)) {
    const n = parseInt(m[1], 10);
    if (n >= 1000 && n <= 99999) out.add(n);
  }
  return [...out];
}

/** Extract the first bare email address from a header value like `Name <a@b.com>`. */
export function extractEmailAddress(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const angle = /<([^>]+)>/.exec(headerValue);
  const candidate = (angle ? angle[1] : headerValue).trim().toLowerCase();
  return /.+@.+\..+/.test(candidate) ? candidate : null;
}

/** Return the first candidate job-number that maps to a live job, else null. */
async function resolveJobNumber(candidates: number[]): Promise<{ jobId: string; hhJobNumber: number } | null> {
  if (candidates.length === 0) return null;
  const result = await query(
    `SELECT id, hh_job_number
       FROM jobs
      WHERE is_deleted = false
        AND hh_job_number = ANY($1::int[])
      ORDER BY updated_at DESC
      LIMIT 1`,
    [candidates],
  );
  if (result.rows.length === 0) return null;
  return { jobId: result.rows[0].id as string, hhJobNumber: result.rows[0].hh_job_number as number };
}

/**
 * Layer 3: sender/recipient email → person → the client's single open job.
 * Only fires on an unambiguous single-open-job resolution. "Open" =
 * pre-completion pipeline stages where a chase/context email is meaningful.
 */
async function resolveByPersonSingleOpenJob(
  addresses: string[],
): Promise<{ jobId: string; hhJobNumber: number | null } | null> {
  const clean = addresses.filter(Boolean);
  if (clean.length === 0) return null;

  const result = await query(
    `WITH matched_people AS (
       SELECT id FROM people
        WHERE lower(email) = ANY($1::text[])
          AND COALESCE(is_deleted, false) = false
     ),
     candidate_jobs AS (
       -- Jobs where a matched person is a per-job contact
       SELECT DISTINCT j.id, j.hh_job_number, j.updated_at
         FROM jobs j
         JOIN job_contacts jc ON jc.job_id = j.id
        WHERE jc.person_id IN (SELECT id FROM matched_people)
          AND j.is_deleted = false
          AND j.pipeline_status IN ('new_enquiry','quoting','paused','provisional','confirmed')
       UNION
       -- Jobs for the client org a matched person works at
       SELECT DISTINCT j.id, j.hh_job_number, j.updated_at
         FROM jobs j
         JOIN person_organisation_roles por ON por.organisation_id = j.client_id
        WHERE por.person_id IN (SELECT id FROM matched_people)
          AND COALESCE(por.status, 'active') = 'active'
          AND j.is_deleted = false
          AND j.pipeline_status IN ('new_enquiry','quoting','paused','provisional','confirmed')
     )
     SELECT id, hh_job_number FROM candidate_jobs`,
    [clean],
  );

  // Only confident when it resolves to exactly one open job.
  if (result.rows.length !== 1) return null;
  return {
    jobId: result.rows[0].id as string,
    hhJobNumber: (result.rows[0].hh_job_number as number | null) ?? null,
  };
}

/**
 * Run the deterministic match layers in priority order. Returns the first
 * confident hit, or null (→ unmatched review queue).
 */
export async function matchEmailToJob(email: ParsedEmailForMatch): Promise<EmailMatchResult | null> {
  // Layer 1: job number in an attached PDF filename.
  const filenameCandidates = email.attachmentFilenames.flatMap((f) => extractJobNumberCandidates(f));
  const byFilename = await resolveJobNumber(filenameCandidates);
  if (byFilename) {
    return { ...byFilename, method: 'pdf_filename_job_number', confidence: 'high' };
  }

  // Layer 2: job number in subject or body.
  const textCandidates = [
    ...extractJobNumberCandidates(email.subject),
    ...extractJobNumberCandidates(email.body),
  ];
  const byText = await resolveJobNumber(textCandidates);
  if (byText) {
    return { ...byText, method: 'subject_body_job_number', confidence: 'high' };
  }

  // Layer 3: sender/recipient email → person → single open job.
  const addresses = [extractEmailAddress(email.from), extractEmailAddress(email.to)].filter(
    (a): a is string => Boolean(a),
  );
  const byPerson = await resolveByPersonSingleOpenJob(addresses);
  if (byPerson) {
    return { ...byPerson, method: 'sender_person_single_open_job', confidence: 'medium' };
  }

  // Layer 4 (AI fuzzy) is a follow-up. No confident match → unmatched queue.
  return null;
}
