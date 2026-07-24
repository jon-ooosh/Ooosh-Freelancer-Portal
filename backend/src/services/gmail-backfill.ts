/**
 * Cold-start email backfill (Auto-Chase — spec §13.1 capstone)
 *
 * Phase 1's baseline ingests nothing historic, so for the first weeks every job
 * has no thread context and chase drafts can't latch onto an existing
 * conversation. This one-off pass fixes that retroactively: for each OPEN
 * pipeline job with an HH number, it searches the mailbox for that job number
 * (`messages.list?q="15800"`), pulls the whole matching thread(s), and ingests
 * every message onto that job's timeline via the shared ingestGmailMessage()
 * (attaching to the KNOWN job, so client replies that don't themselves mention
 * the number still land correctly).
 *
 * Precision: we key off the specific 5-digit HH job number, which is high-signal
 * (HireHop quote emails carry it, and replies quote it). Our own outbound + all
 * internal mail are skipped by the shared guard. Idempotent — the RFC822 dedup
 * means re-running never double-inserts, so it's safe to run repeatedly (e.g. a
 * modest limit at a time).
 *
 * Inert when Gmail isn't configured. Admin-triggered (routes/auto-chase.ts).
 */
import { query } from '../config/database';
import { getPrimaryMailbox, gmailApiGet, gmailSearchMessageIds, isGmailConfigured } from '../config/gmail';
import {
  ingestGmailMessage,
  parseGmailMessageParts,
  extractAllEmailAddresses,
  type GmailMessage,
} from './gmail-ingestion';
import { extractReferencedJobNumbers } from './email-matcher';

const MAX_THREADS_PER_JOB = 8; // guard against a runaway thread fan-out per job

/**
 * The Gmail search `q="16274"` is a broad full-text hit — it also matches
 * UNRELATED threads that happen to contain those digits (eBay order/tracking
 * numbers, prices, postcodes — the eBay-labels incident). Before force-attaching
 * a whole thread we require PROOF it genuinely concerns the job: a `Quote (N)`
 * PDF, an explicit `#N`/`job N`/`quote N` reference in a subject/body, or a
 * message to/from a known job contact. A bare digit-coincidence is rejected.
 */
function threadBelongsToJob(
  messages: GmailMessage[],
  jobNumber: number,
  contactEmails: Set<string>,
): boolean {
  const quotePdfRe = new RegExp(`quote\\s*\\(${jobNumber}\\)`, 'i');
  for (const msg of messages) {
    const p = parseGmailMessageParts(msg);
    // 1. A HireHop quote PDF for THIS job attached.
    if (p.attachmentFilenames.some((f) => quotePdfRe.test(f))) return true;
    // 2. An explicit job reference in the subject or body (not a bare number).
    if (extractReferencedJobNumbers(p.subject).includes(jobNumber)) return true;
    if (extractReferencedJobNumbers(p.body).includes(jobNumber)) return true;
    // 3. A message to/from a known contact of this job.
    const addrs = [
      ...extractAllEmailAddresses(p.from),
      ...extractAllEmailAddresses(p.to),
      ...extractAllEmailAddresses(p.cc),
    ];
    if (addrs.some((a) => contactEmails.has(a))) return true;
  }
  return false;
}

/** Known client-contact emails for a job (job_contacts + client org people + org email). */
async function getJobContactEmails(jobId: string): Promise<Set<string>> {
  const r = await query(
    `SELECT lower(p.email) AS email
       FROM job_contacts jc JOIN people p ON p.id = jc.person_id
      WHERE jc.job_id = $1 AND p.email IS NOT NULL
     UNION
     SELECT lower(p.email) AS email
       FROM jobs j
       JOIN person_organisation_roles por ON por.organisation_id = j.client_id
       JOIN people p ON p.id = por.person_id
      WHERE j.id = $1 AND COALESCE(por.status, 'active') = 'active' AND p.email IS NOT NULL
     UNION
     SELECT lower(o.email) AS email
       FROM jobs j JOIN organisations o ON o.id = j.client_id
      WHERE j.id = $1 AND o.email IS NOT NULL`,
    [jobId],
  );
  return new Set(r.rows.map((row) => row.email).filter(Boolean));
}

// Which pipeline stages to backfill. Lost/cancelled are always excluded.
//  - enquiries: pre-confirmation only (the original chase-draft use case)
//  - active:    enquiries + confirmed + upcoming/out hires (default — covers
//               "confirmed but not yet back" so their threads + summaries land)
//  - all:       active + finished hires too (fullest dispute history; largest)
export type BackfillScope = 'enquiries' | 'active' | 'all';

const PIPELINE_SETS: Record<BackfillScope, string[]> = {
  enquiries: ['new_enquiry', 'quoting', 'paused', 'provisional'],
  active: [
    'new_enquiry', 'quoting', 'paused', 'provisional',
    'confirmed', 'prepped', 'prepping', 'dispatched',
  ],
  all: [
    'new_enquiry', 'quoting', 'paused', 'provisional',
    'confirmed', 'prepped', 'prepping', 'dispatched',
    'returned_incomplete', 'returned', 'completed',
  ],
};

export interface BackfillSummary {
  configured: boolean;
  dryRun: boolean;
  scope: BackfillScope;
  jobsScanned: number;
  jobsWithHits: number;
  threadsScanned: number;
  /** Threads the search matched but that didn't prove they belong to the job. */
  threadsRejected: number;
  logged: number;
  skipped: number;
  duplicates: number;
  error?: string;
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

/**
 * Backfill historical email threads onto open-pipeline jobs.
 * @param opts.limit  how many jobs to process this run (default 500, max 1000)
 * @param opts.dryRun search + count threads but ingest nothing
 * @param opts.scope  which pipeline stages to cover (default 'active')
 * @param opts.sink   optional summary object to write live progress INTO (so a
 *                    background caller can poll counters mid-run). If omitted a
 *                    fresh summary is used. Either way it's returned.
 */
export async function backfillOpenPipelineThreads(
  opts: { limit?: number; dryRun?: boolean; scope?: BackfillScope; sink?: BackfillSummary } = {},
): Promise<BackfillSummary> {
  const scope: BackfillScope = opts.scope && PIPELINE_SETS[opts.scope] ? opts.scope : 'active';
  const summary: BackfillSummary = opts.sink ?? {
    configured: isGmailConfigured(),
    dryRun: Boolean(opts.dryRun),
    scope,
    jobsScanned: 0,
    jobsWithHits: 0,
    threadsScanned: 0,
    threadsRejected: 0,
    logged: 0,
    skipped: 0,
    duplicates: 0,
  };
  // Keep provided sink's descriptive fields in sync with this run.
  summary.configured = isGmailConfigured();
  summary.dryRun = Boolean(opts.dryRun);
  summary.scope = scope;
  if (!summary.configured) return summary;

  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const mailbox = getPrimaryMailbox();
  const statuses = PIPELINE_SETS[scope];

  try {
    // In-scope jobs with an HH number to search on. Most recently touched first.
    const jobs = await query(
      `SELECT id, hh_job_number
         FROM jobs
        WHERE is_deleted = false
          AND hh_job_number IS NOT NULL
          AND pipeline_status = ANY($1::text[])
        ORDER BY updated_at DESC
        LIMIT $2`,
      [statuses, limit],
    );

    for (const job of jobs.rows) {
      summary.jobsScanned++;
      const jobNumber = job.hh_job_number as number;

      let found: { id: string; threadId: string }[];
      try {
        found = await gmailSearchMessageIds(mailbox, `"${jobNumber}"`, 25);
      } catch (err) {
        console.error(`[gmail-backfill] search failed for job ${jobNumber}:`, err);
        continue;
      }
      if (found.length === 0) continue;
      summary.jobsWithHits++;

      const contactEmails = await getJobContactEmails(job.id as string);
      const threadIds = [...new Set(found.map((m) => m.threadId))].slice(0, MAX_THREADS_PER_JOB);
      for (const threadId of threadIds) {
        summary.threadsScanned++;
        if (summary.dryRun) continue; // fast preview: search + count only, no fetch/validate
        let thread: GmailThread;
        try {
          thread = await gmailApiGet<GmailThread>(`/threads/${threadId}?format=full`, mailbox);
        } catch (err) {
          console.error(`[gmail-backfill] thread ${threadId} fetch failed:`, err);
          continue;
        }
        // Prove the thread belongs to this job before attaching any of it — a
        // bare digit coincidence (eBay etc.) is rejected, not force-attached.
        if (!threadBelongsToJob(thread.messages || [], jobNumber, contactEmails)) {
          summary.threadsRejected++;
          continue;
        }
        for (const msg of thread.messages || []) {
          try {
            const outcome = await ingestGmailMessage(mailbox, msg.id, {
              forceJobId: job.id as string,
              prefetched: msg,
            });
            if (outcome === 'logged') summary.logged++;
            else if (outcome === 'duplicate') summary.duplicates++;
            else summary.skipped++; // 'skipped' (internal/automated); 'unmatched' can't happen with forceJobId
          } catch (err) {
            console.error(`[gmail-backfill] ingest ${msg.id} failed:`, err);
          }
        }
      }
    }

    return summary;
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    return summary;
  }
}
