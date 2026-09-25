/**
 * Quote-PDF harvest (Auto-Chase §7.3)
 *
 * Pulls the versioned quote PDFs we emailed for a job out of the mailbox and
 * stores them (bytes → R2, row → job_quote_versions) so the succession can be
 * diffed. Quotes are named `Quote (NNNNN)` where NNNNN = the HH job number.
 *
 * SEARCH-based, deliberately NOT piggybacked on the live ingestion: quotes go
 * out in OUR sent mail, and the ingestion internal-sender filter (§5.4a) skips
 * our own domain. So we search the whole mailbox (sent + received) for the job's
 * number and pull the matching `Quote (NNNNN).pdf` attachments directly. Only
 * `gmail.readonly` is needed (already authorised) — no compose scope.
 *
 * Scoping: harvesting FOR a job filters attachments to that job's OWN number, so
 * a single email carrying quotes for several jobs (observed) contributes each
 * PDF to the correct job independently — no cross-routing needed here.
 *
 * Dedup is two-layered: message-level (skip re-downloading a message we've
 * already pulled) and content-level (SHA-256 of the PDF bytes → the same quote
 * forwarded back / quoted in a reply dedups; different bytes on a later
 * timestamp = a genuine new version). Version ORDER is the message's full
 * timestamp (Gmail internalDate, ms) — the (1)/(2) filename suffix is
 * download-order noise, never a version number.
 *
 * Inert without Gmail — callers guard with isGmailConfigured().
 */
import crypto from 'crypto';
import { query } from '../config/database';
import {
  isGmailConfigured,
  getPrimaryMailbox,
  gmailApiGet,
  gmailGetAttachment,
  gmailSearchMessageIds,
} from '../config/gmail';
import { uploadToR2 } from '../config/r2';

// Matches "Quote (16201)" / "Quote (16201) (4)" etc — captures the HH number,
// ignoring any download-order suffix.
const QUOTE_FILENAME_RE = /quote\s*\((\d{3,7})\)/i;
// Re-search the mailbox for a job at most this often (a job's quote set doesn't
// change minute-to-minute; opening the timeline shouldn't hit Gmail every time).
const HARVEST_STALE_HOURS = 6;
// Cap the Gmail search breadth — a job realistically has a handful of quote
// versions; this bounds a pathological thread.
const SEARCH_MAX = 50;

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface FullMessage {
  id: string;
  threadId: string;
  internalDate?: string; // epoch ms as a string
  payload?: GmailPart;
}

export interface HarvestResult {
  jobId: string;
  configured: boolean;
  searched: number; // messages the Gmail search returned
  fetched: number; // messages we pulled full (not already seen)
  stored: number; // NEW version rows inserted
  duplicates: number; // PDFs whose content hash we already had
  versionsTotal: number; // total versions on the job after this run
  error?: string;
}

/** Collect PDF attachment parts whose filename encodes the given HH job number. */
function collectQuotePdfParts(payload: GmailPart | undefined, hhNumber: string): Array<{ filename: string; attachmentId: string }> {
  const out: Array<{ filename: string; attachmentId: string }> = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const filename = part.filename || '';
    const attachmentId = part.body?.attachmentId;
    if (filename && attachmentId) {
      const m = filename.match(QUOTE_FILENAME_RE);
      const mime = (part.mimeType || '').toLowerCase();
      const looksPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename);
      if (m && m[1] === hhNumber && looksPdf) {
        out.push({ filename, attachmentId });
      }
    }
    if (part.parts) part.parts.forEach(walk);
  };
  walk(payload);
  return out;
}

function sanitiseFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._()-]+/g, '_').slice(0, 120) || 'quote.pdf';
}

async function readHarvestState(jobId: string): Promise<{ last_harvested_at: string | null } | null> {
  const r = await query(`SELECT last_harvested_at FROM job_quote_harvest_state WHERE job_id = $1`, [jobId]);
  return r.rows[0] ?? null;
}

/** Is a fresh mailbox search warranted, or can we serve what's stored? */
export async function shouldHarvest(jobId: string): Promise<boolean> {
  const state = await readHarvestState(jobId);
  if (!state || !state.last_harvested_at) return true;
  const ageMs = Date.now() - new Date(state.last_harvested_at).getTime();
  return ageMs > HARVEST_STALE_HOURS * 3600 * 1000;
}

async function recordState(jobId: string, versionsFound: number, error: string | null): Promise<void> {
  await query(
    `INSERT INTO job_quote_harvest_state (job_id, last_harvested_at, versions_found, last_error, updated_at)
     VALUES ($1, NOW(), $2, $3, NOW())
     ON CONFLICT (job_id) DO UPDATE
       SET last_harvested_at = NOW(), versions_found = EXCLUDED.versions_found,
           last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [jobId, versionsFound, error],
  );
}

/**
 * Harvest the job's quote PDFs from the mailbox into job_quote_versions. Safe to
 * call repeatedly (idempotent via content-hash dedup). Never throws — records a
 * last_error on the harvest state and returns what it managed.
 */
export async function harvestQuotesForJob(jobId: string): Promise<HarvestResult> {
  const result: HarvestResult = {
    jobId,
    configured: isGmailConfigured(),
    searched: 0,
    fetched: 0,
    stored: 0,
    duplicates: 0,
    versionsTotal: 0,
  };
  if (!result.configured) return result;

  const mailbox = getPrimaryMailbox();
  try {
    const jobRes = await query(
      `SELECT hh_job_number FROM jobs WHERE id = $1 AND is_deleted = false`,
      [jobId],
    );
    const hh = jobRes.rows[0]?.hh_job_number;
    if (!hh) {
      // No HH number → nothing to search for. Still mark harvested so we don't
      // re-check on every open.
      await recordState(jobId, 0, null);
      return result;
    }
    const hhNumber = String(hh).trim();

    // Which message ids have we already pulled? (Skip re-download.)
    const seenRes = await query(
      `SELECT DISTINCT source_gmail_message_id FROM job_quote_versions WHERE job_id = $1`,
      [jobId],
    );
    const seenMessageIds = new Set<string>(
      seenRes.rows.map((r) => r.source_gmail_message_id).filter(Boolean),
    );

    // Broad recall (sent + received), precise filter on our side. A bare number
    // reliably matches: Gmail text-extracts the HH number from the quote PDF
    // ("Job Number : 16201") and from subject/body; has:attachment narrows it.
    // We then keep ONLY parts whose filename is `Quote (<thisJob>)`, so a message
    // carrying quotes for several jobs contributes each PDF to the right job.
    const stubs = await gmailSearchMessageIds(mailbox, `has:attachment "${hhNumber}"`, SEARCH_MAX);
    result.searched = stubs.length;

    for (const stub of stubs) {
      if (seenMessageIds.has(stub.id)) continue;
      let msg: FullMessage;
      try {
        msg = await gmailApiGet<FullMessage>(`/messages/${stub.id}?format=full`, mailbox);
      } catch (err) {
        console.error(`[quote-harvest] fetch ${stub.id} failed:`, err);
        continue;
      }
      result.fetched++;
      const receivedAt = msg.internalDate
        ? new Date(Number(msg.internalDate))
        : new Date();
      const parts = collectQuotePdfParts(msg.payload, hhNumber);

      for (const part of parts) {
        let bytes: Buffer;
        try {
          bytes = await gmailGetAttachment(mailbox, msg.id, part.attachmentId);
        } catch (err) {
          console.error(`[quote-harvest] attachment ${part.attachmentId} failed:`, err);
          continue;
        }
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const dupe = await query(
          `SELECT 1 FROM job_quote_versions WHERE job_id = $1 AND content_hash = $2 LIMIT 1`,
          [jobId, hash],
        );
        if (dupe.rows.length > 0) {
          result.duplicates++;
          continue;
        }
        const key = `email-quotes/${jobId}/${msg.id}-${sanitiseFilename(part.filename)}`;
        await uploadToR2(key, bytes, 'application/pdf');
        await query(
          `INSERT INTO job_quote_versions
             (job_id, source_gmail_message_id, received_at, r2_key, filename, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (job_id, content_hash) DO NOTHING`,
          [jobId, msg.id, receivedAt.toISOString(), key, part.filename, hash],
        );
        result.stored++;
      }
    }

    const total = await query(
      `SELECT COUNT(*)::int AS n FROM job_quote_versions WHERE job_id = $1`,
      [jobId],
    );
    result.versionsTotal = Number(total.rows[0]?.n) || 0;
    await recordState(jobId, result.versionsTotal, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    await recordState(jobId, result.versionsTotal, message.slice(0, 1000)).catch(() => undefined);
    return result;
  }
}
