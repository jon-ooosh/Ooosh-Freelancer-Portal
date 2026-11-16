/**
 * The £50 + VAT minimum cancellation fee (T&Cs clause 8.1), ex-VAT throughout,
 * capped at the hire fee so a small hire is never charged more than itself.
 */
import { calculatePreHireCancellation } from '../cancellation-calculator';

const start = new Date('2026-12-20T12:00:00Z');
const daysBefore = (n: number) => new Date(start.getTime() - n * 24 * 60 * 60 * 1000);

describe('calculatePreHireCancellation — minimum fee', () => {
  it('charges 10% when that is more than £50 (more than 7 days)', () => {
    const r = calculatePreHireCancellation({ totalHireCost: 1000, hireStartDate: start, cancellationDate: daysBefore(20) });
    expect(r.fee).toBe(100);
    expect(r.minimumApplied).toBe(false);
  });

  it('charges the £50 minimum when 10% is less (more than 7 days)', () => {
    const r = calculatePreHireCancellation({ totalHireCost: 200, hireStartDate: start, cancellationDate: daysBefore(20) });
    expect(r.fee).toBe(50);
    expect(r.refund).toBe(150);
    expect(r.minimumApplied).toBe(true);
  });

  it('charges the £50 minimum when 25% is less (2-7 days)', () => {
    const r = calculatePreHireCancellation({ totalHireCost: 120, hireStartDate: start, cancellationDate: daysBefore(5) });
    expect(r.fee).toBe(50);
    expect(r.refund).toBe(70);
  });

  it('caps the minimum at the hire fee: a £35 hire costs £35, nothing refunded', () => {
    const r = calculatePreHireCancellation({ totalHireCost: 35, hireStartDate: start, cancellationDate: daysBefore(20) });
    expect(r.fee).toBe(35);
    expect(r.refund).toBe(0);
    expect(r.minimumApplied).toBe(true);
    expect(r.feeBreakdown[0].label).toBe('Minimum cancellation fee (capped at the hire fee)');
  });
});
