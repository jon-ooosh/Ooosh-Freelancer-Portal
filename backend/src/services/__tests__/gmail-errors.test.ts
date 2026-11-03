import { isTransientIngestError } from '../gmail-errors';

describe('isTransientIngestError', () => {
  it('retries Gmail rate limits, including the 403 form seen on the server (Nov 2026)', () => {
    expect(isTransientIngestError(new Error(
      'Gmail API 403 on /threads/19e6f430c2131224?format=metadata: { "error": { "code": 403, "message": "Quota exceeded for quota metric \'Queries\' and limit \'Previous quota: Units per minute per user\'',
    ))).toBe(true);
    expect(isTransientIngestError(new Error('Gmail API 403 on /messages/x: rateLimitExceeded'))).toBe(true);
    expect(isTransientIngestError(new Error('Gmail API 429 on /messages/x: Too many requests'))).toBe(true);
  });

  it('retries Gmail outages, network and database trouble', () => {
    expect(isTransientIngestError(new Error('Gmail API 503 on /messages/x: backend error'))).toBe(true);
    expect(isTransientIngestError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientIngestError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
    expect(isTransientIngestError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientIngestError(new Error('Gmail: failed to obtain access token for info@oooshtours.co.uk'))).toBe(true);
  });

  it('skips a message that is gone or forbidden — retrying would never help', () => {
    // The 404s in the server log (Nov 2026): a message deleted / re-saved before we read it.
    expect(isTransientIngestError(new Error('Gmail API 404 on /messages/1a1a0b3b1302c6d3?format=full: { "error": { "code": 404, "message": "Requested entity was not found." } }'))).toBe(false);
    expect(isTransientIngestError(new Error('Gmail API 403 on /messages/x: Delegation denied for info@oooshtours.co.uk'))).toBe(false);
    expect(isTransientIngestError(new Error('duplicate key value violates unique constraint'))).toBe(false);
  });
});
