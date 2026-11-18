jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { hasLiveHold, releaseKeptMoneyNote, markExcessReleased, STATUS_AFTER_RELEASE_SQL } from '../excess-preauth';
import { query } from '../../config/database';

jest.mock('../excess-requirement-sync', () => ({ syncExcessRequirementStatus: jest.fn(() => Promise.resolve()) }));

const mockQuery = query as jest.Mock;

// One hold OR payments on a record, never both — job 17022, Nov 2026.

describe('hasLiveHold', () => {
  it('is true for a pre_auth record with money held', () => {
    expect(hasLiveHold({ excess_status: 'pre_auth', amount_held: '250.00' })).toBe(true);
  });

  it('is false once the hold is gone, and for every other status', () => {
    expect(hasLiveHold({ excess_status: 'pre_auth', amount_held: '0.00' })).toBe(false);
    expect(hasLiveHold({ excess_status: 'partially_paid', amount_held: null })).toBe(false);
    expect(hasLiveHold({ excess_status: 'released', amount_held: 0 })).toBe(false);
    expect(hasLiveHold({ excess_status: 'needed' })).toBe(false);
  });
});

describe('releaseKeptMoneyNote', () => {
  it('says nothing when no money was taken', () => {
    expect(releaseKeptMoneyNote('0.00')).toBe('');
    expect(releaseKeptMoneyNote(null)).toBe('');
  });

  it('names the money left on the record', () => {
    expect(releaseKeptMoneyNote('950.00')).toContain('£950.00 taken separately is still held');
  });
});

describe('STATUS_AFTER_RELEASE_SQL', () => {
  it('only goes to released when nothing was taken', () => {
    expect(STATUS_AFTER_RELEASE_SQL).toMatch(/excess_amount_taken, 0\) > 0\.005 THEN/);
    expect(STATUS_AFTER_RELEASE_SQL).toMatch(/'partially_paid'/);
    expect(STATUS_AFTER_RELEASE_SQL).toMatch(/ELSE 'released'/);
  });
});

describe('markExcessReleased', () => {
  beforeEach(() => mockQuery.mockReset());

  it('keeps a record with money taken live rather than burying it as released (job 17022)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ job_id: 'job-1', amount_held: '250.00', excess_amount_taken: '950.00', notes: null }] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await markExcessReleased('ex-1', 'test')).toBe(true);

    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain(STATUS_AFTER_RELEASE_SQL);
    expect(sql).not.toMatch(/excess_status\s*=\s*'released'/);
    expect(params[1]).toContain('£950.00 taken separately is still held');
  });

  it('does nothing to a record that is not a held pre-auth', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await markExcessReleased('ex-1', 'test')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
