/**
 * Cost-lines arithmetic. Money, so pinned down rather than eyeballed.
 *
 * The header is authoritative: lines only describe how the invoice breaks down
 * and must add back up to it. Getting the tolerance wrong in either direction
 * is bad — too tight and honest three-way splits are unsaveable, too loose and
 * a real typo reaches Xero.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));

import { validateCostLines, grossesWithResidue } from '../cost-lines';

const header = (gross: number, vat = 0, vat_treatment = 'standard') => ({
  amount_gross: gross, amount_vat: vat, vat_treatment,
});
const line = (gross: number, vat = 0) => ({ amount_gross: gross, amount_vat: vat });

describe('validateCostLines', () => {
  it('accepts no lines at all — a cost without a split is the normal case', () => {
    expect(validateCostLines(header(325), [])).toBeNull();
  });

  it('accepts the worked example: £250 fee + £60 fuel (£10 VAT) + £15 travel', () => {
    expect(validateCostLines(header(325, 10), [line(250), line(60, 10), line(15)])).toBeNull();
  });

  it('rejects lines that undershoot the invoice total', () => {
    const err = validateCostLines(header(325, 10), [line(250), line(60, 10)]);
    expect(err).toMatch(/£310.00/);
    expect(err).toMatch(/£15.00 short/);
  });

  it('rejects lines that overshoot the invoice total', () => {
    expect(validateCostLines(header(100), [line(60), line(50)])).toMatch(/£10.00 too much/);
  });

  it('rejects a gross that balances while the VAT does not', () => {
    // The trap this exists for: the amounts look right, so nothing else would
    // catch it, and the bill goes to Xero with the wrong VAT.
    const err = validateCostLines(header(325, 10), [line(250), line(60, 20), line(15)]);
    expect(err).toMatch(/VAT/);
    expect(err).toMatch(/£10.00 too much/);
  });

  it('allows a 1p residue on both gross and VAT', () => {
    expect(validateCostLines(header(100, 20), [line(33.33, 6.67), line(33.33, 6.67), line(33.33, 6.67)])).toBeNull();
  });

  it('rejects 2p out — the tolerance is a rounding allowance, not a slush fund', () => {
    expect(validateCostLines(header(100), [line(33.33), line(33.33), line(33.32)])).toMatch(/short/);
  });

  it('rejects a zero or negative line', () => {
    expect(validateCostLines(header(100), [line(100), line(0)])).toMatch(/Line 2 needs an amount/);
    expect(validateCostLines(header(100), [line(120), line(-20)])).toMatch(/Line 2 needs an amount/);
  });

  it('rejects VAT larger than its own line', () => {
    expect(validateCostLines(header(100, 60), [line(40, 0), line(60, 60.5)])).toMatch(/Line 2/);
  });

  it('refuses lines on a VAT-reclaim cost, which pushes its own structure', () => {
    expect(validateCostLines(header(100, 20, 'reclaim_split'), [line(100, 20)])).toMatch(/VAT-reclaim/);
  });
});

describe('grossesWithResidue', () => {
  it('leaves an exact split alone', () => {
    expect(grossesWithResidue([line(250), line(60), line(15)], 325)).toEqual([250, 60, 15]);
  });

  it('folds a 1p shortfall onto the largest line so the bill foots', () => {
    const out = grossesWithResidue([line(33.33), line(33.33), line(33.33)], 100);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
    expect(out).toEqual([33.34, 33.33, 33.33]);
  });

  it('folds an overshoot onto the largest line too', () => {
    const out = grossesWithResidue([line(60), line(40.01)], 100);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 2);
    expect(out).toEqual([59.99, 40.01]);
  });

  it('picks the FIRST largest line when two tie, deterministically', () => {
    expect(grossesWithResidue([line(50), line(50)], 100.01)).toEqual([50.01, 50]);
  });

  it('handles numeric strings, which is how pg returns NUMERIC', () => {
    expect(grossesWithResidue([{ amount_gross: '250.00' }, { amount_gross: '75.00' }], 325)).toEqual([250, 75]);
  });

  it('returns an empty array for no lines rather than inventing one', () => {
    expect(grossesWithResidue([], 325)).toEqual([]);
  });
});
