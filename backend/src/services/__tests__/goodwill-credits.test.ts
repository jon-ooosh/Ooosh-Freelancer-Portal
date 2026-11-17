/**
 * Goodwill credit rules (docs/GOODWILL-CREDIT-SPEC.md). The database is mocked:
 * these check what the service refuses and what it writes, not the SQL itself.
 */
jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../job-issues', () => ({ logIssueEvent: jest.fn(async () => undefined) }));

import { query } from '../../config/database';
import {
  reserveGoodwill, markGoodwillApplied, withdrawGoodwill, offerGoodwill, EFFECTIVE_STATUS_SQL, GoodwillError,
} from '../goodwill-credits';

const mockQuery = query as jest.MockedFunction<any>;
const USER = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222-2222-2222-2222-222222222222';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'g1', ref: 'GW-0012', organisation_id: 'o1', person_id: null, owner_name: 'The Band',
  amount_ex_vat: 100, reason: 'Tour cancelled', source_kind: 'cancellation', source_job_id: 'j0',
  source_job_number: 16815, source_issue_id: null, offered_by_name: 'Jon', offered_at: '2026-11-16',
  expires_on: '2027-11-16', status: 'offered', reserved_job_id: null, reserved_job_number: null,
  reserved_for: null, reserved_invoice_number: null, reserved_amount_ex_vat: null, reserved_at: null,
  used_amount_ex_vat: null, used_at: null, used_how: null, withdrawn_at: null, withdrawn_reason: null,
  ...over,
});
const sqls = () => mockQuery.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' '));

beforeEach(() => { mockQuery.mockReset(); });

describe('effective status', () => {
  it('derives expired, and frees a hire reservation on a lost / cancelled job — never an invoice one', () => {
    expect(EFFECTIVE_STATUS_SQL).toContain("g.status = 'offered' AND g.expires_on <");
    expect(EFFECTIVE_STATUS_SQL).toContain("g.reserved_for = 'hire' AND rj.pipeline_status IN ('lost', 'cancelled')");
  });
});

describe('offerGoodwill', () => {
  it('refuses a credit for nobody, or for an org AND a person', async () => {
    await expect(offerGoodwill({ amount_ex_vat: 10, reason: 'x', source_kind: 'organisation' }, USER)).rejects.toBeInstanceOf(GoodwillError);
    await expect(offerGoodwill({ organisation_id: 'o1', person_id: 'p1', amount_ex_vat: 10, reason: 'x', source_kind: 'organisation' }, USER))
      .rejects.toBeInstanceOf(GoodwillError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('defaults the use-by date to 12 months and notes the offer on the source job', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'g1' }] })   // insert
      .mockResolvedValueOnce({ rows: [row()] })          // re-read
      .mockResolvedValue({ rows: [] });                  // notes
    const g = await offerGoodwill({ organisation_id: 'o1', amount_ex_vat: 100, reason: ' Tour cancelled ', source_kind: 'cancellation', source_job_id: 'j0' }, USER);
    expect(g.ref).toBe('GW-0012');
    const insert = mockQuery.mock.calls[0][1];
    expect(insert[3]).toBe('Tour cancelled');
    expect(insert[8]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sqls().some((s: string) => s.includes('INSERT INTO interactions (job_id'))).toBe(true);
  });
});

describe('reserveGoodwill', () => {
  it('refuses one that is already reserved, used or expired', async () => {
    for (const status of ['reserved', 'used', 'expired', 'withdrawn']) {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [row({ status, reserved_job_number: 17000 })] });
      await expect(reserveGoodwill('g1', { job_id: JOB, reserved_for: 'hire', amount_ex_vat: 50 }, USER)).rejects.toBeInstanceOf(GoodwillError);
      expect(sqls().some((s: string) => s.startsWith('UPDATE'))).toBe(false);
    }
  });

  it('refuses more than the credit is worth', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await expect(reserveGoodwill('g1', { job_id: JOB, reserved_for: 'hire', amount_ex_vat: 100.5 }, USER)).rejects.toThrow(/only worth £100.00/);
  });

  it('loses the race cleanly when someone else reserved it first', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row()] })            // read: offered
      .mockResolvedValueOnce({ rows: [{ id: JOB }] })      // job exists
      .mockResolvedValueOnce({ rows: [] });                // guarded UPDATE matched nothing
    await expect(reserveGoodwill('g1', { job_id: JOB, reserved_for: 'hire', amount_ex_vat: 100 }, USER)).rejects.toMatchObject({ status: 409 });
  });

  it('only keeps an invoice number for a reservation against an invoice', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [{ id: JOB }] })
      .mockResolvedValueOnce({ rows: [{ id: 'g1' }] })
      .mockResolvedValueOnce({ rows: [row({ status: 'reserved', reserved_job_id: JOB, reserved_for: 'hire' })] })
      .mockResolvedValue({ rows: [] });
    await reserveGoodwill('g1', { job_id: JOB, reserved_for: 'hire', amount_ex_vat: 80, invoice_number: 'OT-INV-1' }, USER);
    const update = mockQuery.mock.calls[2];
    expect(String(update[0])).toContain("g.expires_on >=");
    expect(update[1][3]).toBeNull();
  });
});

describe('markGoodwillApplied', () => {
  it('needs a reservation first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await expect(markGoodwillApplied('g1', null, USER)).rejects.toThrow(/Reserve it/);
  });

  it('uses the reserved amount by default and says what lapses', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [row({ status: 'reserved', reserved_job_id: JOB, reserved_amount_ex_vat: 80 })] })
      .mockResolvedValueOnce({ rows: [] })                                                     // update
      .mockResolvedValueOnce({ rows: [row({ status: 'used', reserved_job_id: JOB, used_amount_ex_vat: 80 })] })
      .mockResolvedValue({ rows: [] });
    await markGoodwillApplied('g1', null, USER);
    expect(mockQuery.mock.calls[1][1][1]).toBe(80);
    const noteText = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO interactions (job_id'))![1][1];
    expect(noteText).toContain('The other £20.00+VAT lapses');
  });
});

describe('withdrawGoodwill', () => {
  it('refuses a used credit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'used' })] });
    await expect(withdrawGoodwill('g1', 'oops', USER)).rejects.toThrow(/already used/);
  });
});
