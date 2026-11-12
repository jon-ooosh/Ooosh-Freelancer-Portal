/**
 * The Money card's sums (INCIDENT-CLAIMS-SPEC.md §23): everything ex VAT, the
 * estimate stands in until a real cost exists, and insurer money paid straight
 * to the repairer never reduces what it cost us.
 */
import { checkAmounts, costNet, damageTotals, excessCheck } from '../damage-money-maths';

describe('checkAmounts', () => {
  it('takes all three when they add up', () => {
    expect(checkAmounts({ amount_net: 1000, amount_vat: 200, amount_gross: 1200 }))
      .toEqual({ ok: true, net: 1000, vat: 200, gross: 1200 });
  });
  it('allows a penny of rounding', () => {
    expect(checkAmounts({ amount_net: 91.67, amount_vat: 18.33, amount_gross: 110.01 }).ok).toBe(true);
  });
  it('refuses three that do not add up', () => {
    expect(checkAmounts({ amount_net: 1000, amount_vat: 200, amount_gross: 1300 }))
      .toEqual({ ok: false, error: 'Net + VAT doesn’t add up to the gross' });
  });
  it('works out the missing one', () => {
    expect(checkAmounts({ amount_net: 500, amount_vat: 100 })).toEqual({ ok: true, net: 500, vat: 100, gross: 600 });
    expect(checkAmounts({ amount_gross: 600, amount_vat: 100 })).toEqual({ ok: true, net: 500, vat: 100, gross: 600 });
    expect(checkAmounts({ amount_net: 4000, amount_gross: 4000 })).toEqual({ ok: true, net: 4000, vat: 0, gross: 4000 });
  });
  it('refuses nothing, zero and negatives', () => {
    expect(checkAmounts({}).ok).toBe(false);
    expect(checkAmounts({ amount_net: 0, amount_vat: 0, amount_gross: 0 }).ok).toBe(false);
    expect(checkAmounts({ amount_net: 100, amount_vat: -20, amount_gross: 80 }).ok).toBe(false);
  });
});

describe('costNet', () => {
  it('uses the net when there is one, else gross minus VAT', () => {
    expect(costNet({ amount_net: '299.00', amount_gross: '358.80' })).toBe(299);
    expect(costNet({ amount_net: null, amount_gross: '358.80', amount_vat: '59.80' })).toBe(299);
    expect(costNet({ amount_gross: 18 })).toBe(18);
  });
  it('nets a credit (stored negative) off the purchase', () => {
    expect(costNet({ amount_net: '-50.00' })).toBe(-50);
  });
});

describe('damageTotals', () => {
  it('uses the estimate while there are no costs, and says so', () => {
    const t = damageTotals({
      estimateNet: 2000,
      costs: [],
      lines: [{ kind: 'client_recovery', amount_net: 1000, amount_gross: 1200 }],
    });
    expect(t.net_cost).toBe(1000);
    expect(t.net_cost_is_estimate).toBe(true);
    expect(t.recovered_gross).toBe(1200);
  });

  it('switches to the real costs once there is one, ignoring the estimate', () => {
    const t = damageTotals({
      estimateNet: 2000,
      costs: [{ amount_net: '1800.00', amount_vat: '360.00', amount_gross: '2160.00' }],
      lines: [{ kind: 'client_recovery', amount_net: 1000, amount_gross: 1200 }],
    });
    expect(t.costs_net).toBe(1800);
    expect(t.net_cost).toBe(800);
    expect(t.net_cost_is_estimate).toBe(false);
  });

  it('a letter of authorisation: the insurer paid the bodyshop, so only their bill to us is our cost', () => {
    const t = damageTotals({
      estimateNet: 5000,
      costs: [{ amount_net: '1000.00', amount_vat: '200.00', amount_gross: '1200.00' }], // our excess + VAT
      lines: [
        { kind: 'insurer_payment', paid_to: 'repairer', amount_net: 4000, amount_gross: 4000 },
        { kind: 'client_recovery', amount_net: 1000, amount_gross: 1200 },
      ],
    });
    expect(t.insurer_to_repairer).toBe(4000);
    expect(t.insurer_to_us).toBe(0);
    expect(t.net_cost).toBe(0);
  });

  it('insurer money paid to us does reduce our cost', () => {
    const t = damageTotals({
      estimateNet: null,
      costs: [{ amount_net: '5000.00', amount_gross: '6000.00' }],
      lines: [{ kind: 'insurer_payment', paid_to: 'ooosh', amount_net: 4000, amount_gross: 4000 }],
    });
    expect(t.net_cost).toBe(1000);
  });

  it('has no net cost when there is neither a cost nor an estimate', () => {
    const t = damageTotals({ estimateNet: null, costs: [], lines: [{ kind: 'client_recovery', amount_net: 50, amount_gross: 60 }] });
    expect(t.net_cost).toBeNull();
    expect(t.recovered_net).toBe(50);
  });
});

describe('excessCheck', () => {
  it('shows what was kept but not put against any damage', () => {
    // £1,200 bumper + £100 fuel + £60 carpet kept; only the bumper is damage.
    expect(excessCheck(1360, 0, 1200)).toEqual({
      kept_gross: 1360, held_gross: 0, against_damage_gross: 1200, unassigned_gross: 160,
    });
  });
  it('goes negative when more is put against damage than was kept', () => {
    expect(excessCheck(1000, 0, 1200)?.unassigned_gross).toBe(-200);
  });
  it('says nothing for a hire with no excess activity', () => {
    expect(excessCheck(0, 0, 0)).toBeNull();
  });
  it('still shows money held but not yet decided (a captured pre-auth)', () => {
    expect(excessCheck(0, 1200, 0)).toEqual({ kept_gross: 0, held_gross: 1200, against_damage_gross: 0, unassigned_gross: 0 });
  });
});
