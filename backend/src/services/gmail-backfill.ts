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
import { ingestGmailMessage, type GmailMessage } from './gmail-ingestion';

const MAX_THREADS_PER_JOB = 5; // guard against a runaway thread fan-out per job

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

      const threadIds = [...new Set(found.map((m) => m.threadId))].slice(0, MAX_THREADS_PER_JOB);
      for (const threadId of threadIds) {
        summary.threadsScanned++;
        if (summary.dryRun) continue;
        let thread: GmailThread;
        try {
          thread = await gmailApiGet<GmailThread>(`/threads/${threadId}?format=full`, mailbox);
        } catch (err) {
          console.error(`[gmail-backfill] thread ${threadId} fetch failed:`, err);
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
