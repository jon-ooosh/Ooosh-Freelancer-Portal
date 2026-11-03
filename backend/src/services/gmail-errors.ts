/**
 * Is this failure worth trying again later? (Gmail ingestion, Nov 2026.)
 *
 * The ingestion loop skips a message that fails and still moves its bookmark
 * (the Gmail history cursor) forward — fine for a message that is GONE (404:
 * a draft that was re-saved, an email deleted before we read it), but a
 * temporary failure meant that email never reached OP. Temporary = Gmail
 * rate limits (403/429 "quota"), Gmail server errors (5xx), the network, or
 * our own database being unreachable. For those the loop stops and leaves the
 * bookmark where it was, so the next run (10 minutes later) tries again; the
 * messages it had already done are skipped as duplicates.
 *
 * Kept on its own (no database import) so it can be unit-tested.
 */
export function isTransientIngestError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Gmail reports rate limits as 403 as well as 429 — but a plain 403 is a
  // permission problem, so only when it says quota / rate limit.
  if (/Gmail API (403|429)/.test(msg) && /quota|rate ?limit/i.test(msg)) return true;
  if (/Gmail API 429/.test(msg)) return true;
  if (/Gmail API 5\d\d/.test(msg)) return true;
  if (/failed to obtain (compose )?access token/i.test(msg)) return true;
  // Network trouble (Gmail or Postgres).
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(msg)) return true;
  // Postgres pool / connection trouble.
  if (/Connection terminated|timeout exceeded when trying to connect|too many clients/i.test(msg)) return true;
  return false;
}
