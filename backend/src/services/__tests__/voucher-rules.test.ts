import { VOUCHER_ALPHABET, exVatOf, lineGross, makeVoucherCode, normaliseVoucherCode, spreadVoucher } from '../voucher-rules';

describe('voucher codes', () => {
  it('makes XXXX-XXXX-XXXX from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeVoucherCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      for (const ch of code.replace(/-/g, '')) expect(VOUCHER_ALPHABET).toContain(ch);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('is random enough that 2,000 codes never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(makeVoucherCode());
    expect(seen.size).toBe(2000);
  });

  it('reads what staff type, whatever the case, spaces or dashes', () => {
    expect(normaliseVoucherCode('k7qm 4xwp c9tr')).toBe('K7QM-4XWP-C9TR');
    expect(normaliseVoucherCode('K7QM4XWPC9TR')).toBe('K7QM-4XWP-C9TR');
    expect(normaliseVoucherCode(' k7qm-4xwp-c9tr ')).toBe('K7QM-4XWP-C9TR');
  });

  it('refuses anything that cannot be a code — including a GW ref', () => {
    expect(normaliseVoucherCode('GW-0013')).toBeNull();
    expect(normaliseVoucherCode('K7QM-4XWP-C9T')).toBeNull();      // too short
    expect(normaliseVoucherCode('K7QM-4XWP-C9TO')).toBeNull();     // O is not in the alphabet
    expect(normaliseVoucherCode('')).toBeNull();
    expect(normaliseVoucherCode(null)).toBeNull();
  });
});

describe('VAT', () => {
  it('£20 inc VAT is £16.67 ex VAT, and back to £20.00', () => {
    expect(exVatOf(20)).toBe(16.67);
    expect(Math.round(exVatOf(20) * 120) / 100).toBe(20);
  });
});

describe('spreading a voucher across a basket', () => {
  const tshirt = { hhStockId: 1, qty: 1, unitPrice: 12.5, vatRatePct: 20 };   // £15.00 inc
  const strings = { hhStockId: 2, qty: 3, unitPrice: 5, vatRatePct: 20 };      // £18.00 inc
  const book = { hhStockId: 3, qty: 1, unitPrice: 8, vatRatePct: 0 };          // £8.00 zero-rated

  it('takes the whole voucher off when the basket is worth more, dearest line first', () => {
    const r = spreadVoucher([tshirt, strings], 20);
    expect(r.takenOff).toBeGreaterThan(19.9);
    expect(r.takenOff).toBeLessThanOrEqual(20);
    // The strings (£18) went first and to nothing; the T-shirt took the rest.
    const before = lineGross(12.5, 1, 20) + lineGross(5, 3, 20);
    const after = r.lines.reduce((s, l) => s + lineGross(l.unitPrice, l.qty, l.vatRatePct), 0);
    expect(Math.round((before - after) * 100) / 100).toBe(r.takenOff);
    expect(r.lines.find((l) => l.hhStockId === 2)!.unitPrice).toBe(0);
  });

  it('takes exactly £20 off a £33 basket (VAT rounding never costs the customer a penny here)', () => {
    expect(spreadVoucher([tshirt, strings], 20).takenOff).toBe(20);
  });

  it('never takes off more than the basket is worth — the rest lapses', () => {
    const r = spreadVoucher([tshirt], 20);
    expect(r.takenOff).toBe(15);
    expect(r.lines[0].unitPrice).toBe(0);
  });

  it('a zero-rated line is covered pound for pound', () => {
    const r = spreadVoucher([book], 5);
    expect(r.takenOff).toBe(5);
    expect(r.lines[0].unitPrice).toBe(3);
  });

  it('never goes over the voucher, whatever the rounding', () => {
    for (const v of [0.01, 0.07, 1.99, 3.33, 7.77, 10, 19.99, 20, 23.45]) {
      const r = spreadVoucher([tshirt, strings, book, { hhStockId: 4, qty: 7, unitPrice: 1.25, vatRatePct: 20 }], v);
      expect(r.takenOff).toBeLessThanOrEqual(v);
      expect(v - r.takenOff).toBeLessThan(0.1);   // only a few pence lost to quantities
      for (const l of r.lines) expect(l.unitPrice).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves the basket alone with no voucher', () => {
    const r = spreadVoucher([tshirt, strings], 0);
    expect(r.takenOff).toBe(0);
    expect(r.lines).toEqual([tshirt, strings]);
  });
});
