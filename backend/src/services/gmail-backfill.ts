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

export interface BackfillSummary {
  configured: boolean;
  dryRun: boolean;
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
 * @param opts.limit  how many jobs to process this run (default 50, max 200)
 * @param opts.dryRun search + count threads but ingest nothing
 */
export async function backfillOpenPipelineThreads(
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    configured: isGmailConfigured(),
    dryRun: Boolean(opts.dryRun),
    jobsScanned: 0,
    jobsWithHits: 0,
    threadsScanned: 0,
    logged: 0,
    skipped: 0,
    duplicates: 0,
  };
  if (!summary.configured) return summary;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const mailbox = getPrimaryMailbox();

  try {
    // Open pipeline jobs that have an HH number to search on. Most recently
    // touched first, so a capped run covers the freshest enquiries.
    const jobs = await query(
      `SELECT id, hh_job_number
         FROM jobs
        WHERE is_deleted = false
          AND hh_job_number IS NOT NULL
          AND pipeline_status IN ('new_enquiry','quoting','paused','provisional','confirmed')
        ORDER BY updated_at DESC
        LIMIT $1`,
      [limit],
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
