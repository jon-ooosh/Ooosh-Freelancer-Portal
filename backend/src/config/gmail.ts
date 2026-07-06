/**
 * Gmail Ingestion Configuration (Auto-Chase Phase 1)
 *
 * Reads the info@oooshtours.co.uk mailbox (and later the manager mailboxes)
 * via Google Workspace DOMAIN-WIDE DELEGATION: one service account, consented
 * once by the Workspace admin, can impersonate any mailbox in the domain
 * without per-user OAuth.
 *
 * We deliberately DON'T pull in the giant `googleapis` package. `google-auth-
 * library` mints a delegated OAuth2 access token from the service-account JWT
 * (subject = the mailbox we're impersonating), and we call the Gmail REST API
 * (https://gmail.googleapis.com/gmail/v1) with plain fetch. Lean + explicit.
 *
 * Inert until configured — every call site guards with isGmailConfigured() and
 * degrades cleanly (the ingestion scheduler logs "disabled" and skips, the
 * status endpoint returns { configured: false }). The app boots fine without
 * any GMAIL_* env vars set.
 *
 * Required env vars (see docs/AUTO-CHASE-SPEC.md §5.1 + the deploy notes):
 *   GMAIL_SERVICE_ACCOUNT_JSON — the service-account key JSON. Either the raw
 *                                JSON string, OR a path to the .json file on
 *                                the server. We auto-detect which.
 *   GMAIL_DELEGATED_USER       — the mailbox to impersonate for the primary
 *                                info@ ingestion (e.g. info@oooshtours.co.uk).
 *
 * Mirrors the Stripe / Anthropic config pattern (config/stripe.ts).
 */
import { readFileSync } from 'fs';
import { JWT } from 'google-auth-library';

// Read-only Gmail scope — used by the ingestion path (§5). Kept on its own JWT
// client so ingestion physically cannot create or send anything.
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// Compose scope — Phase 2 draft creation only (§9). Allows create/read/update
// of drafts (and send, which we deliberately DON'T call — staff send from Gmail).
// On its own client so the two capabilities stay separated.
const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** The primary mailbox we ingest first (§5). Manager mailboxes are §6. */
export function getPrimaryMailbox(): string {
  return process.env.GMAIL_DELEGATED_USER || 'info@oooshtours.co.uk';
}

/**
 * Is Gmail ingestion configured on this server? Callers guard with this before
 * attempting any Gmail work, so an unconfigured environment is a clean no-op
 * rather than a throw.
 */
export function isGmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_SERVICE_ACCOUNT_JSON && process.env.GMAIL_DELEGATED_USER);
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  [k: string]: unknown;
}

let cachedKey: ServiceAccountKey | null = null;

/**
 * Load the service-account key from GMAIL_SERVICE_ACCOUNT_JSON. Accepts either
 * the raw JSON blob or a filesystem path (auto-detected: a value starting with
 * '{' is treated as inline JSON, otherwise as a path).
 */
function loadServiceAccountKey(): ServiceAccountKey {
  if (cachedKey) return cachedKey;
  const raw = process.env.GMAIL_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'GMAIL_SERVICE_ACCOUNT_JSON is not set. Add the service-account key ' +
        '(inline JSON or a path to the .json) to backend/.env on the server.',
    );
  }
  const jsonStr = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf-8');
  const key = JSON.parse(jsonStr) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) {
    throw new Error('GMAIL_SERVICE_ACCOUNT_JSON is missing client_email / private_key.');
  }
  cachedKey = key;
  return key;
}

// One JWT client per (impersonated mailbox × scope-set). The `subject` differs
// per mailbox; readonly vs compose are separate clients so the two capabilities
// don't bleed together.
const jwtClients = new Map<string, JWT>();
const composeClients = new Map<string, JWT>();

/**
 * Build (or reuse) a READ-ONLY domain-wide-delegation JWT client impersonating
 * `mailbox`. Defaults to the primary info@ mailbox.
 */
export function getGmailAuthClient(mailbox: string = getPrimaryMailbox()): JWT {
  const existing = jwtClients.get(mailbox);
  if (existing) return existing;

  const key = loadServiceAccountKey();
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [GMAIL_READONLY_SCOPE],
    subject: mailbox, // impersonate this mailbox (domain-wide delegation)
  });
  jwtClients.set(mailbox, client);
  return client;
}

/**
 * Build (or reuse) a COMPOSE-scope JWT client impersonating `mailbox` — used
 * ONLY for draft creation (§9). Requires `gmail.compose` on the DWD client
 * authorization in the Workspace admin console.
 */
export function getGmailComposeClient(mailbox: string = getPrimaryMailbox()): JWT {
  const existing = composeClients.get(mailbox);
  if (existing) return existing;

  const key = loadServiceAccountKey();
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [GMAIL_COMPOSE_SCOPE],
    subject: mailbox,
  });
  composeClients.set(mailbox, client);
  return client;
}

/**
 * Call a Gmail REST endpoint for the given mailbox, authenticated via the
 * delegated JWT. `path` is relative to the user root, e.g.
 * `/messages/{id}?format=full` → GET .../users/{mailbox}/messages/{id}?format=full.
 *
 * Throws on non-2xx (callers catch + record last_error on gmail_sync_state).
 */
export async function gmailApiGet<T = unknown>(
  path: string,
  mailbox: string = getPrimaryMailbox(),
): Promise<T> {
  const client = getGmailAuthClient(mailbox);
  const token = await client.getAccessToken();
  if (!token || !token.token) {
    throw new Error(`Gmail: failed to obtain access token for ${mailbox}`);
  }
  const url = `${GMAIL_API_BASE}/users/${encodeURIComponent(mailbox)}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gmail API ${resp.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

/**
 * Create a Gmail DRAFT in `mailbox` (compose scope). `raw` is a base64url-encoded
 * RFC822 message; pass `threadId` to latch the draft onto an existing thread.
 * Returns the created draft's id + message/thread ids. Staff send it from Gmail —
 * OP never calls the send endpoint.
 */
export async function createGmailDraft(
  mailbox: string,
  message: { raw: string; threadId?: string },
): Promise<{ id: string; message?: { id: string; threadId: string } }> {
  const client = getGmailComposeClient(mailbox);
  const token = await client.getAccessToken();
  if (!token || !token.token) {
    throw new Error(`Gmail: failed to obtain compose access token for ${mailbox}`);
  }
  const url = `${GMAIL_API_BASE}/users/${encodeURIComponent(mailbox)}/drafts`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gmail draft create ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as { id: string; message?: { id: string; threadId: string } };
}

/**
 * Lightweight connectivity probe used by the status endpoint. Returns the
 * mailbox's current profile (email + historyId) — proves the delegation +
 * scopes are working end-to-end without ingesting anything.
 */
export async function getGmailProfile(
  mailbox: string = getPrimaryMailbox(),
): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
  return gmailApiGet<{ emailAddress: string; historyId: string; messagesTotal: number }>(
    '/profile',
    mailbox,
  );
}
