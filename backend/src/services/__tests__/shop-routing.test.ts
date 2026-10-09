/**
 * Step 7: which jobs a till sale may go on. Refused at the counter, while the
 * customer is still there — not discovered by the drain after they've gone.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { query } from '../../config/database';
import { assertSellableJob, searchSellableJobs } from '../shop-routing';

const mockQuery = query as unknown as jest.Mock;
const job = (over: Record<string, unknown>) => ({
  rows: [{ hh_job_number: 16800, pipeline_status: 'dispatched', is_deleted: false, is_internal: false, ...over }],
});

beforeEach(() => mockQuery.mockReset());

describe('assertSellableJob', () => {
  it('allows a live job — including a returned one, which consumes stock like dispatched (jon, job 16749)', async () => {
    mockQuery.mockResolvedValueOnce(job({}));
    await expect(assertSellableJob('j')).resolves.toBeUndefined();
    mockQuery.mockResolvedValueOnce(job({ pipeline_status: 'returned' }));
    await expect(assertSellableJob('j')).resolves.toBeUndefined();
  });

  it.each(['cancelled', 'lost', 'completed'])('refuses a %s job', async (status) => {
    mockQuery.mockResolvedValueOnce(job({ pipeline_status: status }));
    await expect(assertSellableJob('j')).rejects.toThrow(/walk-in/);
  });

  it('refuses internal, deleted, missing and un-numbered jobs', async () => {
    mockQuery.mockResolvedValueOnce(job({ is_internal: true }));
    await expect(assertSellableJob('j')).rejects.toThrow(/Used for Ooosh/);
    mockQuery.mockResolvedValueOnce(job({ is_deleted: true }));
    await expect(assertSellableJob('j')).rejects.toThrow(/no longer exists/);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assertSellableJob('j')).rejects.toThrow(/no longer exists/);
    mockQuery.mockResolvedValueOnce(job({ hh_job_number: null }));
    await expect(assertSellableJob('j')).rejects.toThrow(/HireHop job number/);
  });
});

describe('searchSellableJobs', () => {
  it('does not hit the database for a one-character search', async () => {
    await expect(searchSellableJobs('w')).resolves.toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('escapes LIKE wildcards, so "100%" is a literal search', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await searchSellableJobs('100%');
    expect(mockQuery.mock.calls[0][1][2]).toBe('%100\\%%');
  });
});
