/**
 * The gate on AI-proposed cost lines.
 *
 * A split is a convenience; the totals are what we pay. So the rule is one-way —
 * lines that don't reconcile are DISCARDED, never nudged into agreement. A
 * missing split costs someone thirty seconds of typing; a plausible-but-wrong
 * one reaches Xero and nobody notices. These pin that asymmetry down.
 */
jest.mock('../document-extract', () => ({ extractDocument: jest.fn() }));
jest.mock('../xero-broker', () => ({ xeroBroker: { getContacts: jest.fn() } }));

import { reconcileLines, normaliseCostDate, type ExtractedReceipt, type ExtractedLine } from '../cost-receipt-extract';

const receipt = (gross: number | null, vat: number, lines: Partial<ExtractedLine>[]): ExtractedReceipt => ({
  supplier: 'Rossetts', cost_date: null, due_date: null,
  amount_gross: gross, amount_vat: vat, amount_net: gross == null ? null : gross - vat,
  vat_treatment: 'standard', invoice_number: null, job_number: null,
  vehicle_reg: null, mileage: null, service_type: null,
  description: null, category_code: null, confidence: 'high',
  lines: lines.map((l) => ({ description: null, amount_gross: 0, amount_vat: 0, category_code: null, ...l })),
});

describe('reconcileLines', () => {
  it('keeps a split that reconciles on both gross and VAT', () => {
    const p = receipt(325, 10, [
      { amount_gross: 250, amount_vat: 0, category_code: '320' },
      { amount_gross: 60, amount_vat: 10, category_code: '410' },
      { amount_gross: 15, amount_vat: 0, category_code: '325' },
    ]);
    reconcileLines(p);
    expect(p.lines).toHaveLength(3);
    expect(p.confidence).toBe('high');
  });

  it('discards a split whose amounts do not sum to the total', () => {
    const p = receipt(325, 10, [
      { amount_gross: 250, amount_vat: 0 },
      { amount_gross: 60, amount_vat: 10 },
    ]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('discards a split that balances on gross but not on VAT', () => {
    // The dangerous one: the money looks right, so nothing downstream would
    // catch it, and the bill goes to Xero with the wrong VAT.
    const p = receipt(325, 10, [
      { amount_gross: 250, amount_vat: 0 },
      { amount_gross: 75, amount_vat: 12.50 },
    ]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('downgrades confidence when it throws a split away', () => {
    const p = receipt(100, 0, [{ amount_gross: 60, amount_vat: 0 }, { amount_gross: 30, amount_vat: 0 }]);
    reconcileLines(p);
    expect(p.confidence).toBe('medium');
  });

  it('allows 1p of rounding slack, the same as the save path', () => {
    const p = receipt(100, 0, [
      { amount_gross: 33.33, amount_vat: 0 },
      { amount_gross: 33.33, amount_vat: 0 },
      { amount_gross: 33.33, amount_vat: 0 },
    ]);
    reconcileLines(p);
    expect(p.lines).toHaveLength(3);
  });

  it('discards a single line — that is the cost again, not a split', () => {
    const p = receipt(100, 0, [{ amount_gross: 100, amount_vat: 0 }]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('discards a line with VAT larger than the line itself', () => {
    const p = receipt(100, 60, [
      { amount_gross: 40, amount_vat: 0 },
      { amount_gross: 60, amount_vat: 60.01 },
    ]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('discards a zero or negative line', () => {
    const p = receipt(100, 0, [{ amount_gross: 100, amount_vat: 0 }, { amount_gross: 0, amount_vat: 0 }]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('discards everything when the document has no total to check against', () => {
    const p = receipt(null, 0, [{ amount_gross: 60, amount_vat: 0 }, { amount_gross: 40, amount_vat: 0 }]);
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });

  it('survives the model omitting lines entirely', () => {
    const p = receipt(100, 0, []);
    // @ts-expect-error — the model can return no key at all, schema or not.
    delete p.lines;
    reconcileLines(p);
    expect(p.lines).toEqual([]);
  });
});

/**
 * Cost-date plausibility. The "Last year" filter immediately surfaced receipts
 * the reader had dated 2025 and even 2024 — misread years, not genuinely old
 * paperwork. The repair is a prompt anchored on today's date plus a human
 * double-check; what's pinned here is that we FLAG an implausibly old date and
 * never quietly rewrite it, because a historic invoice does occasionally get
 * captured and moving its date would be worse than the misread.
 */
describe('normaliseCostDate — implausibly old', () => {
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

  const dated = (d: string | null): ExtractedReceipt => ({ ...receipt(100, 0, []), cost_date: d });

  it('leaves a recent date alone and keeps confidence high', () => {
    const p = dated(iso(-3));
    normaliseCostDate(p);
    expect(p.cost_date).toBe(iso(-3));
    expect(p.confidence).toBe('high');
  });

  it('flags a year-old date by downgrading confidence', () => {
    const p = dated(iso(-400));
    normaliseCostDate(p);
    expect(p.confidence).toBe('medium');
  });

  it('does NOT rewrite the date — a real historic invoice must survive', () => {
    const p = dated('2024-08-23');
    normaliseCostDate(p);
    expect(p.cost_date).toBe('2024-08-23');
  });

  it('does not nag just inside the window', () => {
    const p = dated(iso(-90));
    normaliseCostDate(p);
    expect(p.confidence).toBe('high');
  });
});
