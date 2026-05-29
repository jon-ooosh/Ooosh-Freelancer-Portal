/**
 * Xero Configuration (Custom Connection — client_credentials)
 *
 * OP connects to exactly ONE Xero org (Ooosh's own), server-to-server, with no
 * end-user in the auth loop. This is the textbook Custom Connection case:
 *   - grant_type=client_credentials (no authorization-code flow)
 *   - NO refresh tokens, NO 60-day manual reauthorisation
 *   - the broker mints a fresh ~30-min access token on demand from
 *     client_id + client_secret, indefinitely
 *
 * Required env vars (set in backend/.env on the server — never commit):
 *   XERO_CLIENT_ID
 *   XERO_CLIENT_SECRET
 *
 * Do NOT instantiate Xero calls elsewhere — go through services/xero-broker.ts
 * so token management, the single-tenant resolution, and rate limiting live in
 * one place.
 */
import dotenv from 'dotenv';

dotenv.config();

export interface XeroConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Space-separated scopes requested on the token. Must match (or be a subset
   * of) the scopes ticked when the Custom Connection was created in the Xero
   * developer portal. accounting.contacts is needed to attach a supplier to an
   * ACCPAY bill; drop it here only if the connection wasn't granted it.
   */
  scopes: string;
}

export const XERO_IDENTITY_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// The Ooosh Custom Connection (May 2026) was granted:
//   accounting.banktransactions(.read), accounting.settings(.read),
//   accounting.attachments(.read), accounting.contacts(.read)
// We request the write-level scopes (which imply read). This covers chart of
// accounts / tax rates / tracking categories (settings), reading COT bank
// transactions + creating SPEND money (banktransactions), supplier linkage
// (contacts) and receipt upload (attachments).
//
// NOT granted: `accounting.transactions` — the scope governing ACCPAY *Invoices*
// (supplier bills). createBill() in the broker will 403 until that scope is added
// to the connection and it's reconnected. Everything else works as-is.
const DEFAULT_SCOPES = [
  'accounting.banktransactions',
  'accounting.settings',
  'accounting.contacts',
  'accounting.attachments',
].join(' ');

export function getXeroConfig(): XeroConfig {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured. Add them to ' +
      'backend/.env on the server. Xero operations cannot proceed without them.'
    );
  }

  return {
    clientId,
    clientSecret,
    scopes: process.env.XERO_SCOPES || DEFAULT_SCOPES,
  };
}

/**
 * Guard before attempting a Xero operation. Cost-capture routes have both a
 * Xero-channel and a passive-record path — we want a clean 503 if staff try a
 * Xero action on a server missing the creds, not an unhandled throw.
 */
export function isXeroConfigured(): boolean {
  return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
}

/**
 * Type guard for Xero API error payloads. Xero returns a JSON body with a
 * `Type`/`Message` on validation errors, or an OAuth-style `error` on token
 * failures. We surface either shape so routes can decide between 502 (Xero
 * rejected) and 503 (not configured / auth).
 */
export interface XeroErrorShape {
  status?: number;
  message: string;
  detail?: unknown;
}

export function isXeroError(err: unknown): err is XeroErrorShape {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  );
}
