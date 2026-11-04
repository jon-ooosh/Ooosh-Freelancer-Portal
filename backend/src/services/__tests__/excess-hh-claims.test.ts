jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { planClaimCatchUp, totalsByDeposit, catchUpHireHopExcessClaims, HhExcessApplication } from '../excess-hh-claims';
import { query } from '../../config/database';

const mockQuery = query as jest.Mock;

const app = (over: Partial<HhExcessApplication> = {}): HhExcessApplication => ({
  appId: 11, depositId: 500, invoiceId: 900, amount: 1200, date: '2026-09-28', crossJob: false, ...over,
});

describe('planClaimCatchUp', () => {
  it('records what HireHop applied when OP shows nothing claimed (job 16325)', () => {
    expect(planClaimCatchUp({ taken: 1200, claimed: 0, reimbursed: 0 }, 1200)).toEqual({ newClaim: 1200, gap: 1200, capped: false });
  });

  it('does nothing when OP already matches — a claim made with OP\'s own button is in HireHop too', () => {
    expect(planClaimCatchUp({ taken: 1200, claimed: 1200, reimbursed: 0 }, 1200)).toBeNull();
  });

  it('never lowers a claim OP already shows', () => {
    expect(planClaimCatchUp({ taken: 1200, claimed: 800, reimbursed: 0 }, 300)).toBeNull();
  });

  it('records only the part OP is missing', () => {
    expect(planClaimCatchUp({ taken: 1200, claimed: 300, reimbursed: 0 }, 750)).toEqual({ newClaim: 750, gap: 450, capped: false });
  });

  it('never claims more than the deposit has left after refunds', () => {
    expect(planClaimCatchUp({ taken: 1200, claimed: 0, reimbursed: 1000 }, 1200)).toEqual({ newClaim: 200, gap: 200, capped: true });
  });
});

describe('totalsByDeposit', () => {
  it('adds up per deposit and counts each HireHop application once', () => {
    const g = totalsByDeposit([app(), app(), app({ appId: 12, amount: 50.5 }), app({ appId: 13, depositId: 501, amount: 99 })]);
    expect(g.get(500)?.total).toBe(1250.5);
    expect(g.get(500)?.apps).toHaveLength(2);
    expect(g.get(501)?.total).toBe(99);
  });

  it('ignores rows with no deposit or no amount', () => {
    expect(totalsByDeposit([app({ depositId: 0 }), app({ appId: 14, amount: 0 })]).size).toBe(0);
  });
});

describe('catchUpHireHopExcessClaims', () => {
  beforeEach(() => mockQuery.mockReset());

  it('writes the claim in OP only, as fully claimed, and says where it came from', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', hh_deposit_id: 500, excess_status: 'taken', excess_amount_taken: '1200.00', claim_amount: null, reimbursement_amount: null, claim_notes: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1' }] });
    const n = await catchUpHireHopExcessClaims('job-1', [app()]);
    expect(n).toBe(1);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/UPDATE job_excess/);
    expect(sql).toMatch(/COALESCE\(claim_amount, 0\) < \$2::numeric - 0\.005/);   // only while OP is behind
    expect(params[0]).toBe('ex-1');
    expect(params[1]).toBe(1200);
    expect(params[2]).toBe('fully_claimed');
    expect(params[3]).toBe('2026-09-28');
    expect(params[4]).toMatch(/applied to the invoice in HireHop on 2026-09-28 \(HireHop row 11\) — recorded by OP from HireHop/);
  });

  it('keeps the status when part of the excess is still held', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1', hh_deposit_id: 500, excess_status: 'taken', excess_amount_taken: '1200', claim_amount: '0', reimbursement_amount: '0', claim_notes: 'old note' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'ex-1' }] });
    await catchUpHireHopExcessClaims('job-1', [app({ amount: 400 })]);
    const params = mockQuery.mock.calls[1][1];
    expect(params[2]).toBe('taken');
    expect(params[4]).toMatch(/^old note\n/);
  });

  it("doesn't guess when two OP records share a HireHop deposit", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: 'a', hh_deposit_id: 500, excess_status: 'taken', excess_amount_taken: '1200' },
      { id: 'b', hh_deposit_id: 500, excess_status: 'taken', excess_amount_taken: '1200' },
    ] });
    expect(await catchUpHireHopExcessClaims('job-1', [app()])).toBe(0);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('makes no call at all without applications', async () => {
    expect(await catchUpHireHopExcessClaims('job-1', [])).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
