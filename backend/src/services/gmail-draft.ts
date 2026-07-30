/**
 * Gmail chase-draft creation (Auto-Chase Phase 2, §9.1 step 2)
 *
 * Turns the AI chase draft (services/chase-draft.ts) into a real Gmail draft
 * sitting in info@, ready for a human to glance at and send. Latches onto the
 * client's existing thread when we have one (from Phase 1 ingestion), else
 * creates a standalone draft addressed to the client.
 *
 * Needs the `gmail.compose` DWD scope (config/gmail.ts getGmailComposeClient).
 * We ONLY create the draft — staff send it from Gmail. OP never calls send.
 *
 * Recipient + thread resolution:
 *   1. Most recent INBOUND ingested client email on the job with a thread id →
 *      reply into that thread (To = their address, In-Reply-To = their Message-ID,
 *      threadId set so Gmail threads it). This is the ideal "latch onto the
 *      conversation" case.
 *   2. Otherwise → job_contacts primary person's email, standalone draft (no
 *      thread). Covers the common "we quoted, silence, no client reply yet" case
 *      (our own outbound quote is filtered out of ingestion, so we don't have its
 *      thread id — a standalone draft to the client is the honest fallback).
 *   3. No resolvable client email → throw (staff addresses it manually).
 */
import { query } from '../config/database';
import { getPrimaryMailbox, createGmailDraft, sendGmailDraft, gmailSearchMessageIds, gmailApiGet, isGmailConfigured } from '../config/gmail';
import { draftChaseEmail } from './chase-draft';
import { extractEmailAddress } from './email-matcher';

const FROM_DISPLAY = 'Ooosh Tours';

export interface CreatedChaseDraft {
  draftId: string;
  gmailMessageId: string | null;
  threadId: string | null;
  to: string;
  subject: string;
  threaded: boolean;
  body: string;
  /** True when the auto-send path actually sent the draft (§10). */
  sent: boolean;
}

interface RecipientResolution {
  to: string;
  threadId: string | null;
  inReplyTo: string | null; // RFC822 Message-ID of the message we're replying to
}

/** base64url with no padding — Gmail's `raw` expects URL-safe base64. */
function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Encode a header value that may contain non-ASCII (RFC 2047, UTF-8 base64). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function buildRawMessage(opts: {
  fromMailbox: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
}): string {
  const headers: string[] = [];
  headers.push(`From: ${encodeHeader(FROM_DISPLAY)} <${opts.fromMailbox}>`);
  headers.push(`To: ${opts.to}`);
  headers.push(`Subject: ${encodeHeader(opts.subject)}`);
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.inReplyTo}`);
  }
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: 8bit');
  const mime = `${headers.join('\r\n')}\r\n\r\n${opts.body}`;
  return toBase64Url(mime);
}

interface GmailThreadMeta {
  messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>;
}

/**
 * RFC822 Message-ID of the NEWEST message in a thread. We reply to that so the
 * draft appends at the END of the conversation. Latching onto the most recent
 * *inbound* message (all we ingest) mis-positions the draft when we've since
 * sent an outbound reply the client hasn't answered — Gmail shows it mid-thread
 * (the Johan Rydén case). threads.get returns messages oldest→newest.
 */
async function latestThreadMessageId(threadId: string, mailbox: string): Promise<string | null> {
  const thread = await gmailApiGet<GmailThreadMeta>(
    `/threads/${threadId}?format=metadata&metadataHeaders=Message-ID`,
    mailbox,
  );
  const msgs = thread.messages || [];
  if (msgs.length === 0) return null;
  const headers = msgs[msgs.length - 1].payload?.headers || [];
  return headers.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? null;
}

/** Resolve who the chase goes to, and whether we can latch onto a thread. */
async function resolveRecipient(jobId: string): Promise<RecipientResolution | null> {
  const mailbox = getPrimaryMailbox();
  let to: string | null = null;
  let threadId: string | null = null;

  // 1. Latch onto the client's ingested thread, if any (most recent inbound).
  const threadRow = await query(
    `SELECT gmail_thread_id, email_from
       FROM interactions
      WHERE job_id = $1 AND type = 'email' AND email_direction = 'inbound'
        AND gmail_thread_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [jobId],
  );
  if (threadRow.rows.length > 0) {
    to = extractEmailAddress(threadRow.rows[0].email_from);
    threadId = threadRow.rows[0].gmail_thread_id as string;
  }

  // 2. Fall back to the job's primary contact email. For the "silent quote" case
  //    (client never replied, so nothing ingested), still try to latch onto the
  //    original sent-quote thread by searching the mailbox for the job number —
  //    so the chase threads into the conversation rather than arriving cold.
  if (!to) {
    const contactRow = await query(
      `SELECT p.email
         FROM job_contacts jc
         JOIN people p ON p.id = jc.person_id
        WHERE jc.job_id = $1
          AND p.email IS NOT NULL AND p.email <> ''
          AND COALESCE(p.is_deleted, false) = false
        ORDER BY jc.is_primary DESC NULLS LAST, jc.created_at ASC
        LIMIT 1`,
      [jobId],
    );
    if (contactRow.rows.length === 0) return null;
    to = extractEmailAddress(contactRow.rows[0].email) || String(contactRow.rows[0].email).trim();
    if (!to) return null;
  }
  if (!threadId) {
    const jobRow = await query(`SELECT hh_job_number FROM jobs WHERE id = $1`, [jobId]);
    const hh = jobRow.rows[0]?.hh_job_number;
    if (hh) {
      try {
        const found = await gmailSearchMessageIds(mailbox, `"${hh}"`, 10);
        if (found.length > 0) threadId = found[0].threadId; // Gmail's most-relevant thread
      } catch {
        /* non-fatal — fall back to a standalone draft */
      }
    }
  }

  // Reply to the newest message in the thread (not the latest inbound) so the
  // draft lands at the end of the conversation.
  let inReplyTo: string | null = null;
  if (threadId) {
    try {
      inReplyTo = await latestThreadMessageId(threadId, mailbox);
    } catch {
      /* non-fatal — thread still set, draft just won't carry In-Reply-To */
    }
  }
  return { to, threadId, inReplyTo };
}

/**
 * Create a chase draft in info@ for a job. Returns details of the created draft.
 * Throws with a clear message when Gmail/Anthropic aren't configured, the job
 * isn't found, or no client email is resolvable (caller maps to 4xx/5xx).
 */
export async function createChaseDraftForJob(
  jobId: string,
  signOffName?: string | null,
  opts: { send?: boolean } = {},
): Promise<CreatedChaseDraft> {
  if (!isGmailConfigured()) {
    throw new Error('Gmail is not configured — cannot create drafts.');
  }

  // AI draft first (also validates the job exists + is draftable). Signed off
  // from the staff member who clicked "Draft chase" (falls back to the team).
  const { draft } = await draftChaseEmail(jobId, { signOffName });

  const recipient = await resolveRecipient(jobId);
  if (!recipient) {
    throw new Error(
      'No client email on file for this job — add a contact with an email (or wait for a client reply to latch onto) before drafting a chase.',
    );
  }

  const mailbox = getPrimaryMailbox();
  const raw = buildRawMessage({
    fromMailbox: mailbox,
    to: recipient.to,
    subject: draft.subject,
    body: draft.body,
    inReplyTo: recipient.inReplyTo,
  });

  const created = await createGmailDraft(mailbox, {
    raw,
    ...(recipient.threadId ? { threadId: recipient.threadId } : {}),
  });

  // Opt-in auto-send (§10). The caller only sets send=true once the master
  // switch + suppression gate have passed; a send failure is fatal to this call
  // (the draft still exists in info@ for a human to send manually).
  let sent = false;
  let threadId = created.message?.threadId ?? recipient.threadId ?? null;
  if (opts.send) {
    const result = await sendGmailDraft(mailbox, created.id);
    sent = true;
    threadId = result.threadId ?? threadId;
  }

  return {
    draftId: created.id,
    gmailMessageId: created.message?.id ?? null,
    threadId,
    to: recipient.to,
    subject: draft.subject,
    threaded: Boolean(recipient.threadId),
    body: draft.body,
    sent,
  };
}
