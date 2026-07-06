/**
 * Gmail Ingestion Service (Auto-Chase Phase 1)
 *
 * Polls a delegated mailbox (info@ first), logs new client emails onto job
 * timelines as `interactions` (type='email'), and drops the residue into the
 * gmail_unmatched_inbound review queue. This is the foundation the auto-chase
 * (Phase 2) sits on: because inbound emails become contact-type interactions,
 * the existing chase-model auto-bump keeps the pipeline honest for free (see
 * CLAUDE.md "Pipeline Chase Model" + docs/AUTO-CHASE-SPEC.md §3, §5).
 *
 * Inert until configured — runIngestionForPrimaryMailbox() no-ops cleanly when
 * isGmailConfigured() is false.
 *
 * Incremental via the Gmail History API: we store the mailbox's historyId as a
 * cursor (gmail_sync_state) and fetch only messages added since. On the very
 * first run we establish a baseline (record the current historyId, ingest
 * nothing) so we don't retro-ingest the entire archive — ingestion starts from
 * go-live forward. A full historical backfill, attachment→R2 harvesting, and
 * AI thread summaries are deliberate follow-ups (spec §5.5, §8).
 *
 * Dedup is on the RFC822 Message-ID header (partial-unique index on
 * interactions.gmail_message_id + gmail_unmatched_inbound), so once §6 adds the
 * manager mailboxes the same email surfacing in four inboxes still logs once.
 */
import { query } from '../config/database';
import { getGmailProfile, gmailApiGet, getPrimaryMailbox, isGmailConfigured } from '../config/gmail';
import { matchEmailToJob, extractEmailAddress } from './email-matcher';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ── Internal / automated sender filtering ───────────────────────────────────
// info@ is a firehose of our OWN mail: every internal notification / alert /
// reminder is sent from notifications@ or a staff address (all @oooshtours.co.uk),
// and MANY of them carry a HH job number (referral alerts, pre-hire briefings,
// the client-no-email fallback, chase/holding digests, …). Left unfiltered those
// would match a real job via the matcher's job-number layer and pollute the job
// timeline with our own notifications masquerading as client replies.
//
// The rule: an inbound email FROM our own domain is internal/automated — skip it
// (don't log, don't queue). Client replies are always from external domains, so
// this is a clean cut. It also correctly drops our own SENT copies (Phase 2 owns
// draft-vs-sent capture) and the client-no-email fallback (which is really our
// bounced OUTBOUND, not a client reply). Stays correct into Phase 1.5 manager
// mailboxes: a client replying to Sarah is still external (kept); Sarah's outbound
// is from our domain (skipped). Only loss: a staff FORWARD of a client thread into
// info@ — acceptable, that's manager-mailbox territory.
//
// Stable, so a constant. Extend here if we ever quote from another owned domain.
const INTERNAL_SENDER_DOMAINS = ['oooshtours.co.uk'];

// EXCEPTION to the internal/automated skip: website enquiry-form emails arrive
// via Resend and MAY carry a From on our own domain (e.g. enquiries@oooshtours.co.uk),
// which the domain rule below would otherwise skip. We don't build enquiry
// auto-create until Phase 4 (§11), so skipping them now is harmless — but list
// the exact enquiry-form From address(es) here to keep them flowing the moment
// extraction lands. Matched addresses bypass BOTH the internal-domain and
// automated guards. Empty until we confirm the sender. Lowercase, full address.
const ENQUIRY_SOURCE_ADDRESSES: string[] = [];

function isEnquirySource(from: string | null): boolean {
  const addr = extractEmailAddress(from);
  return addr != null && ENQUIRY_SOURCE_ADDRESSES.includes(addr);
}

function senderDomain(from: string | null): string | null {
  const addr = extractEmailAddress(from);
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  return at === -1 ? null : addr.slice(at + 1);
}

function isInternalSender(from: string | null): boolean {
  const domain = senderDomain(from);
  if (!domain) return false;
  return INTERNAL_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Belt-and-braces guard for EXTERNAL automated mail (bounces, out-of-office,
 * newsletters) so it doesn't clog the unmatched queue. Conservative — keys off
 * headers only auto-generated mail sets, so a genuine client reply never trips it.
 */
function looksAutomated(headers: GmailHeader[] | undefined): boolean {
  const autoSubmitted = (headerValue(headers, 'Auto-Submitted') || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true; // auto-generated / auto-replied
  const precedence = (headerValue(headers, 'Precedence') || '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
  return false;
}

// ── Gmail REST payload shapes (only the fields we read) ─────────────────────
interface GmailHeader { name: string; value: string }
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}
interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
}
interface GmailHistoryList {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

export interface IngestionSummary {
  mailbox: string;
  configured: boolean;
  baselineEstablished: boolean;
  fetched: number;
  logged: number;
  unmatched: number;
  duplicates: number;
  /** Internal (own-domain) or automated (bounce/OOO/bulk) mail skipped entirely. */
  skipped: number;
  error?: string;
}

// ── Header helpers ──────────────────────────────────────────────────────────
function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function decodeBase64Url(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

/** Walk the MIME tree, returning the best plain-text body + attachment filenames. */
function extractBodyAndAttachments(payload: GmailPart | undefined): {
  body: string;
  attachmentFilenames: string[];
  hasAttachments: boolean;
} {
  let plain = '';
  let html = '';
  const attachmentFilenames: string[] = [];

  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    const filename = part.filename || '';
    if (filename && (part.body?.attachmentId || part.body?.size)) {
      attachmentFilenames.push(filename);
    }
    if (mime === 'text/plain' && part.body?.data) {
      plain += decodeBase64Url(part.body.data);
    } else if (mime === 'text/html' && part.body?.data) {
      html += decodeBase64Url(part.body.data);
    }
    if (part.parts) part.parts.forEach(walk);
  };
  walk(payload);

  // Prefer plain text; fall back to a crude HTML→text strip.
  const body = plain.trim()
    ? plain
    : html
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

  return { body, attachmentFilenames, hasAttachments: attachmentFilenames.length > 0 };
}

// ── Cursor state ────────────────────────────────────────────────────────────
async function getSyncState(mailbox: string): Promise<{ history_id: string | null } | null> {
  const r = await query(`SELECT history_id FROM gmail_sync_state WHERE mailbox = $1`, [mailbox]);
  return r.rows[0] ?? null;
}

async function upsertBaseline(mailbox: string, historyId: string): Promise<void> {
  await query(
    `INSERT INTO gmail_sync_state (mailbox, history_id, last_synced_at, last_error)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (mailbox) DO UPDATE
       SET history_id = EXCLUDED.history_id, last_synced_at = NOW(), last_error = NULL`,
    [mailbox, historyId],
  );
}

async function advanceCursor(mailbox: string, historyId: string, seen: number): Promise<void> {
  await query(
    `UPDATE gmail_sync_state
        SET history_id = $2, last_synced_at = NOW(), last_error = NULL,
            messages_seen = messages_seen + $3, updated_at = NOW()
      WHERE mailbox = $1`,
    [mailbox, historyId, seen],
  );
}

async function recordError(mailbox: string, message: string): Promise<void> {
  await query(
    `INSERT INTO gmail_sync_state (mailbox, last_error, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (mailbox) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [mailbox, message.slice(0, 1000)],
  );
}

// ── Per-message processing ──────────────────────────────────────────────────
async function processMessage(
  mailbox: string,
  messageId: string,
  counters: { logged: number; unmatched: number; duplicates: number; skipped: number },
): Promise<void> {
  // Dedup up front — cheap and avoids a Gmail fetch when we already have it.
  const rfcIdProbe = await query(
    `SELECT 1 FROM interactions WHERE gmail_message_id = $1
     UNION ALL
     SELECT 1 FROM gmail_unmatched_inbound WHERE gmail_message_id = $1
     LIMIT 1`,
    [messageId],
  );
  // NB: we dedup on the Gmail message resource id here as a fast pre-check; the
  // authoritative dedup is the RFC822 Message-ID stored below (globally unique
  // across mailboxes). Gmail's per-mailbox id is stable enough for the fast path.
  if (rfcIdProbe.rows.length > 0) {
    counters.duplicates++;
    return;
  }

  const msg = await gmailApiGet<GmailMessage>(`/messages/${messageId}?format=full`, mailbox);
  const headers = msg.payload?.headers;
  const rfcMessageId = headerValue(headers, 'Message-ID') || `gmail:${msg.id}`;
  const from = headerValue(headers, 'From');
  const to = headerValue(headers, 'To');
  const subject = headerValue(headers, 'Subject');

  // Internal / automated guard — before matching. An email from our own domain
  // is a notification/alert/our-own-sent-copy, not a client reply; external
  // auto-generated mail (bounces / OOO / bulk) is noise. Skip entirely: don't
  // log to a timeline, don't queue. The cursor advances past it so it won't
  // reappear. (See INTERNAL_SENDER_DOMAINS note above.)
  if (!isEnquirySource(from) && (isInternalSender(from) || looksAutomated(headers))) {
    counters.skipped++;
    return;
  }

  const { body, attachmentFilenames, hasAttachments } = extractBodyAndAttachments(msg.payload);

  // Authoritative dedup on the RFC822 Message-ID (unique across mailboxes).
  const dupe = await query(
    `SELECT 1 FROM interactions WHERE gmail_message_id = $1
     UNION ALL
     SELECT 1 FROM gmail_unmatched_inbound WHERE gmail_message_id = $1
     LIMIT 1`,
    [rfcMessageId],
  );
  if (dupe.rows.length > 0) {
    counters.duplicates++;
    return;
  }

  // Direction: SENT label → outbound (our reply), else inbound (client email).
  const direction = (msg.labelIds || []).includes('SENT') ? 'outbound' : 'inbound';
  const snippet = (msg.snippet || body).slice(0, 500);

  const match = await matchEmailToJob({ from, to, subject, body, attachmentFilenames });

  if (match) {
    // Log as a job-timeline interaction. Inbound client emails feed the
    // chase-model auto-bump; our own outbound replies do NOT (the auto-chase
    // reschedules itself) — but note the auto-bump lives in the interactions
    // ROUTE, not the raw table INSERT, so a direct INSERT here does not bump.
    // Phase 2's chase logic owns the bump explicitly; foundation just records.
    await query(
      `INSERT INTO interactions
         (type, content, job_id, created_by,
          gmail_message_id, gmail_thread_id, email_from, email_to, email_subject,
          email_snippet, email_direction, has_attachments)
       VALUES ('email', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        body || snippet || '(no body)',
        match.jobId,
        SYSTEM_USER_ID,
        rfcMessageId,
        msg.threadId,
        from,
        to,
        subject,
        snippet,
        direction,
        hasAttachments,
      ],
    );
    counters.logged++;
  } else {
    await query(
      `INSERT INTO gmail_unmatched_inbound
         (mailbox, gmail_message_id, gmail_thread_id, email_from, email_to,
          email_subject, email_snippet, has_attachments, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (gmail_message_id) DO NOTHING`,
      [mailbox, rfcMessageId, msg.threadId, from, to, subject, snippet, hasAttachments],
    );
    counters.unmatched++;
  }
}

// ── History-delta fetch ─────────────────────────────────────────────────────
async function fetchAddedMessageIds(mailbox: string, startHistoryId: string): Promise<{ ids: string[]; newHistoryId: string }> {
  const ids: string[] = [];
  let newHistoryId = startHistoryId;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const qs = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const page = await gmailApiGet<GmailHistoryList>(`/history?${qs.toString()}`, mailbox);
    if (page.historyId) newHistoryId = page.historyId;
    for (const rec of page.history || []) {
      for (const added of rec.messagesAdded || []) {
        // Skip our own drafts-in-progress / spam / trash noise as it appears.
        const labels = added.message.labelIds || [];
        if (labels.includes('DRAFT') || labels.includes('TRASH') || labels.includes('SPAM')) continue;
        ids.push(added.message.id);
      }
    }
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < 25); // hard page cap — a huge backlog is caught next run

  // Dedup ids (a message can appear in multiple history records)
  return { ids: [...new Set(ids)], newHistoryId };
}

/**
 * Ingest new mail for the primary (info@) mailbox. Safe to call on a schedule.
 * No-ops cleanly when Gmail isn't configured.
 */
export async function runIngestionForPrimaryMailbox(): Promise<IngestionSummary> {
  const mailbox = getPrimaryMailbox();
  const summary: IngestionSummary = {
    mailbox,
    configured: isGmailConfigured(),
    baselineEstablished: false,
    fetched: 0,
    logged: 0,
    unmatched: 0,
    duplicates: 0,
    skipped: 0,
  };
  if (!summary.configured) return summary;

  try {
    const state = await getSyncState(mailbox);

    // First run for this mailbox → establish baseline, ingest nothing.
    if (!state || !state.history_id) {
      const profile = await getGmailProfile(mailbox);
      await upsertBaseline(mailbox, profile.historyId);
      summary.baselineEstablished = true;
      return summary;
    }

    const { ids, newHistoryId } = await fetchAddedMessageIds(mailbox, state.history_id);
    summary.fetched = ids.length;

    const counters = { logged: 0, unmatched: 0, duplicates: 0, skipped: 0 };
    for (const id of ids) {
      try {
        await processMessage(mailbox, id, counters);
      } catch (err) {
        // One bad message shouldn't stall the batch; log + continue.
        console.error(`[gmail-ingestion] message ${id} failed:`, err);
      }
    }
    summary.logged = counters.logged;
    summary.unmatched = counters.unmatched;
    summary.duplicates = counters.duplicates;
    summary.skipped = counters.skipped;

    await advanceCursor(mailbox, newHistoryId, ids.length);
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.error = message;
    await recordError(mailbox, message).catch(() => undefined);
    return summary;
  }
}

/**
 * Status probe for the admin endpoint — proves configuration + connectivity
 * without ingesting. Returns { configured, mailbox, profile?, syncState?, error? }.
 */
export async function getGmailIngestionStatus(): Promise<{
  configured: boolean;
  mailbox: string;
  profile?: { emailAddress: string; historyId: string; messagesTotal: number };
  syncState?: { history_id: string | null; last_synced_at: string | null; last_error: string | null; messages_seen: number };
  error?: string;
}> {
  const mailbox = getPrimaryMailbox();
  if (!isGmailConfigured()) return { configured: false, mailbox };
  try {
    const profile = await getGmailProfile(mailbox);
    const r = await query(
      `SELECT history_id, last_synced_at, last_error, messages_seen
         FROM gmail_sync_state WHERE mailbox = $1`,
      [mailbox],
    );
    return { configured: true, mailbox, profile, syncState: r.rows[0] };
  } catch (err) {
    return { configured: true, mailbox, error: err instanceof Error ? err.message : String(err) };
  }
}
