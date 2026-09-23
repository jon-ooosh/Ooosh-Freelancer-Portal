/**
 * The §2.5 rule, in code: `success: true` does NOT mean HireHop did it.
 *
 * Verified live on scratch job 16735 — `save_job.php` accepted a delete
 * instruction, returned `success: true` with a full job payload, and changed
 * nothing. The only tell was what the response did NOT contain.
 *
 * So a push is judged on the OBJECT HireHop returns, never on the flag. These
 * tests pin that, because the failure mode if it regresses is silent: OP would
 * record a stock adjustment that never happened, and the shelf count would
 * drift exactly the way this module exists to stop.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../hirehop-broker', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

import hhBroker from '../hirehop-broker';
import { pushTally } from '../shop-drain';

const mockPost = (hhBroker as unknown as { post: jest.Mock }).post;

beforeEach(() => mockPost.mockReset());

describe('pushTally', () => {
  it('records the adjustment id when HireHop really made one', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 2238, QTY: -1, DETAILS: 'Snare re-head' } });
    await expect(pushTally(25, 1, 'Snare re-head')).resolves.toEqual({ tallyId: 2238, error: null });
  });

  it('always sends a NEGATIVE qty, whatever sign the caller passed', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 1, QTY: -3 } });
    await pushTally(25, 3, 'x');
    expect(mockPost.mock.calls[0][1]).toMatchObject({ cons: 25, qty: -3, id: 0 });

    mockPost.mockResolvedValue({ success: true, data: { ID: 2, QTY: -3 } });
    await pushTally(25, -3, 'x');
    // A caller that already negated must not flip it back to an increase.
    expect(mockPost.mock.calls[1][1]).toMatchObject({ qty: -3 });
  });

  it('creates rather than edits — id 0', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 9, QTY: -1 } });
    await pushTally(25, 1, 'x');
    // A real id here would EDIT an existing adjustment instead of adding one.
    expect(mockPost.mock.calls[0][1]).toMatchObject({ id: 0 });
  });

  it('REJECTS success:true with no adjustment id — the §2.5 trap', async () => {
    mockPost.mockResolvedValue({ success: true, data: { some: 'other payload' } });
    const r = await pushTally(25, 1, 'x');
    expect(r.tallyId).toBeNull();
    expect(r.error).toMatch(/returned no ID/i);
  });

  it('REJECTS an adjustment that moved a different amount', async () => {
    // Recording "we consumed 1" when HireHop consumed 5 is worse than failing.
    mockPost.mockResolvedValue({ success: true, data: { ID: 77, QTY: -5 } });
    const r = await pushTally(25, 1, 'x');
    expect(r.tallyId).toBeNull();
    expect(r.error).toMatch(/adjusted by -5, expected -1/i);
  });

  it('passes a HireHop rejection through', async () => {
    mockPost.mockResolvedValue({ success: false, error: '327' });
    const r = await pushTally(25, 1, 'x');
    expect(r.tallyId).toBeNull();
    expect(r.error).toBe('327');
  });

  it('truncates an over-long reason rather than letting HireHop reject it', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 5, QTY: -1 } });
    await pushTally(25, 1, 'x'.repeat(400));
    expect((mockPost.mock.calls[0][1] as any).details.length).toBe(250);
  });
});
