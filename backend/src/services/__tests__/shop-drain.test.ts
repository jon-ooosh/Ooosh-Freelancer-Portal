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
import { pushTally, pushSaleLine } from '../shop-drain';

const mockPost = (hhBroker as unknown as { post: jest.Mock }).post;

beforeEach(() => mockPost.mockReset());

describe('pushTally', () => {
  it('records the adjustment id when HireHop really made one', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 2238, QTY: -1, DETAILS: 'Snare re-head' } });
    await expect(pushTally(25, 1, 'Snare re-head')).resolves.toEqual({ tallyId: 2238, error: null });
  });

  it('sends the CAPTURED parameter names, not the documented ones', async () => {
    // HireHop's API docs describe `cons`, `id`, `qty`, `details`. The endpoint
    // actually wants CONSUMABLE_ID / ID / QTY / DETAILS plus local, tz and
    // CUSTOM_FIELDS — and returns error 3 for the documented shape. This test
    // exists so nobody "tidies" these back to match the documentation.
    mockPost.mockResolvedValue({ success: true, data: { ID: 1, QTY: -3 } });
    await pushTally(25, 3, 'Snare re-head');

    const sent = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(sent).toMatchObject({
      ID: 0,                  // 0 creates; a real id would EDIT an adjustment
      CONSUMABLE_ID: 25,
      QTY: -3,
      DETAILS: 'Snare re-head',
      CUSTOM_FIELDS: '{}',
      tz: 'Europe/London',
    });
    expect(sent).not.toHaveProperty('cons');
    expect(sent).not.toHaveProperty('qty');
    // Local wall-clock time, not UTC — HireHop stamps the adjustment with it.
    expect(sent.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('always sends a NEGATIVE qty, whatever sign the caller passed', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 2, QTY: -3 } });
    await pushTally(25, -3, 'x');
    // A caller that already negated must not flip it back into an increase.
    expect(mockPost.mock.calls[0][1]).toMatchObject({ QTY: -3 });
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

  it('carries HireHop\'s whole reply, not just the bare code', async () => {
    // A live failure stored push_error = "blue fluoro tape: 3" and the code
    // alone told us nothing about what HireHop objected to. The reply goes on
    // the row so it is still readable after the journal has rotated.
    mockPost.mockResolvedValue({ success: false, error: '3', data: { hint: 'whatever HH said' } });
    const r = await pushTally(25, 1, 'x');
    expect(r.tallyId).toBeNull();
    expect(r.error).toContain('"error":"3"');
    expect(r.error).toContain('whatever HH said');
  });

  it('truncates a runaway reply rather than storing a wall of text', async () => {
    mockPost.mockResolvedValue({ success: false, error: 'x'.repeat(2000) });
    const r = await pushTally(25, 1, 'x');
    expect((r.error || '').length).toBeLessThan(500);
  });

  it('truncates an over-long reason rather than letting HireHop reject it', async () => {
    mockPost.mockResolvedValue({ success: true, data: { ID: 5, QTY: -1 } });
    await pushTally(25, 1, 'x'.repeat(400));
    expect((mockPost.mock.calls[0][1] as any).DETAILS.length).toBe(250);
  });
});

/**
 * Putting a sale line on a HireHop job.
 *
 * `save_job.php` returns the created line in its own response, which is what
 * makes this one call rather than the recharge pattern's four. It is also the
 * §2.5 trap in a new place: the flag says accepted, the payload says what was
 * actually done, and only the second one is evidence. A line we record but
 * HireHop never created means stock we think we sold and still have.
 */
describe('pushSaleLine', () => {
  const accepted = (line: Record<string, unknown>) =>
    ({ success: true, data: { items: { itms: [line] } } });

  it('returns the created line id and the price HireHop used', async () => {
    mockPost.mockResolvedValue(accepted({ ID: '9154', LIST_ID: '25', UNIT_PRICE: '7.500000' }));
    await expect(pushSaleLine(16750, 25, 1))
      .resolves.toEqual({ lineId: 9154, unitPrice: 7.5, error: null });
  });

  it("addresses sale stock as a<id> — b would add HIRE stock of the same number", async () => {
    mockPost.mockResolvedValue(accepted({ ID: '1', LIST_ID: '25', UNIT_PRICE: '7.5' }));
    await pushSaleLine(16750, 25, 3);
    const sent = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(sent).toMatchObject({ job: 16750, items: JSON.stringify({ a25: 3 }) });
  });

  it('REJECTS success:true that returned no line at all', async () => {
    mockPost.mockResolvedValue({ success: true, data: { items: { itms: [] } } });
    const r = await pushSaleLine(16750, 25, 1);
    expect(r.lineId).toBeNull();
    expect(r.error).toMatch(/did not return it/i);
  });

  it('REJECTS a line for a DIFFERENT stock item', async () => {
    // Recording line 9154 as our tape when it is someone else's drum head means
    // a later reversal deletes the wrong line.
    mockPost.mockResolvedValue(accepted({ ID: '9154', LIST_ID: '999', UNIT_PRICE: '7.5' }));
    const r = await pushSaleLine(16750, 25, 1);
    expect(r.lineId).toBeNull();
  });

  it('passes a HireHop rejection through', async () => {
    mockPost.mockResolvedValue({ success: false, error: '327' });
    const r = await pushSaleLine(16750, 25, 1);
    expect(r.lineId).toBeNull();
    expect(r.error).toContain('327');
  });
});
