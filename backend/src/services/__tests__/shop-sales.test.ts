/**
 * Shop till arithmetic and the discount ceiling. Money, so pinned down.
 *
 * Two behaviours here are easy to get subtly wrong and expensive when you do:
 *
 * 1. VAT is rounded PER LINE. A basket can mix rates — 971 sale items are
 *    standard-rated and 3 are zero-rated — so totalling then taxing would
 *    charge VAT on the zero-rated flapjack.
 * 2. The discount ceiling is a percentage of the TRANSACTION, not of a line.
 *    A per-line cap blocks the ordinary rounding case: knocking £2 off a £52
 *    basket of £1 cans means discounting one can by 100%, even though the
 *    customer is getting 4% off.
 *
 * Note the fallback DIRECTION differs from shop-stock.ts on purpose. The VAT and
 * category fallbacks there fail OPEN, because they govern what staff can see.
 * These fail CLOSED, because they govern money leaving the business.
 */
// Type-only imports don't make a file a module; this does. Without it TS treats
// these tests as global scripts and they collide on shared helper names.
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

type ShopSales = typeof import('../shop-sales');

interface StockRow {
  hh_stock_id: number;
  title: string;
  price: number;
  vat_rate_index: number | null;
  max_discount: number | null;
}

const TAPE: StockRow = {
  hh_stock_id: 25, title: '1" green fluoro tape', price: 7.5,
  vat_rate_index: 0, max_discount: 100,
};
const FLAPJACK: StockRow = {
  hh_stock_id: 671, title: 'Trek - Cocoa Oat protein flapjack', price: 1.6,
  vat_rate_index: 1, max_discount: 100,
};
const CAPPED: StockRow = {
  hh_stock_id: 900, title: 'Something barely discountable', price: 10,
  vat_rate_index: 0, max_discount: 10,
};

/**
 * Fresh module registry with `query` routed by SQL text rather than call order —
 * `priceLines` reads stock once but resolves VAT through a cached settings read,
 * so a positional mock would break the moment the cache behaviour changed.
 */
async function freshModule(opts: {
  stock?: StockRow[];
  vatMap?: string | null;
  caps?: string | null;
} = {}): Promise<ShopSales> {
  jest.resetModules();
  const db = await import('../../config/database');
  (db.query as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('shop_stock_cache')) {
      const wanted = (params?.[0] as number[]) || [];
      return { rows: (opts.stock || []).filter(s => wanted.includes(s.hh_stock_id)) };
    }
    if (sql.includes('system_settings')) {
      const key = (params?.[0] as string) || '';
      const value = key === 'shop_discount_caps'
        ? (opts.caps === undefined ? null : opts.caps)
        : key === 'shop_vat_rate_map'
          ? (opts.vatMap === undefined ? '{"0":20,"1":0,"2":5}' : opts.vatMap)
          : null;
      return { rows: value === null ? [] : [{ value }] };
    }
    return { rows: [] };
  });
  return import('../shop-sales');
}

describe('priceLines', () => {
  it('prices a line from the catalogue, ex-VAT, with VAT on top', async () => {
    const m = await freshModule({ stock: [TAPE] });
    const [line] = await m.priceLines([{ hhStockId: 25, qty: 2 }]);
    expect(line.unitPriceCharged).toBe(7.5);     // HireHop holds ex-VAT
    expect(line.lineNet).toBe(15);
    expect(line.lineVat).toBe(3);
    expect(line.lineGross).toBe(18);             // what the customer hands over
  });

  it('charges no VAT on a genuinely zero-rated item', async () => {
    const m = await freshModule({ stock: [FLAPJACK] });
    const [line] = await m.priceLines([{ hhStockId: 671, qty: 1 }]);
    expect(line.vatRatePct).toBe(0);
    expect(line.lineGross).toBe(1.6);
  });

  it('rejects a price ABOVE list — that is a typo or an unagreed markup', async () => {
    const m = await freshModule({ stock: [TAPE] });
    await expect(m.priceLines([{ hhStockId: 25, qty: 1, unitPriceCharged: 9 }]))
      .rejects.toThrow(/cannot be sold above/i);
  });

  it("respects HireHop's own per-item discount ceiling", async () => {
    const m = await freshModule({ stock: [CAPPED] });
    // 20% off an item HireHop caps at 10% would be rejected on the push, so it
    // is refused before anyone takes the money.
    await expect(m.priceLines([{ hhStockId: 900, qty: 1, unitPriceCharged: 8 }]))
      .rejects.toThrow(/at most 10% discount/i);
    await expect(m.priceLines([{ hhStockId: 900, qty: 1, unitPriceCharged: 9 }]))
      .resolves.toHaveLength(1);
  });

  it('refuses an item that is not in the catalogue', async () => {
    const m = await freshModule({ stock: [TAPE] });
    await expect(m.priceLines([{ hhStockId: 999, qty: 1 }])).rejects.toThrow(/not in the catalogue/i);
  });

  it('refuses a zero or negative quantity', async () => {
    const m = await freshModule({ stock: [TAPE] });
    await expect(m.priceLines([{ hhStockId: 25, qty: 0 }])).rejects.toThrow(/quantity/i);
  });

  it('refuses an empty basket', async () => {
    const m = await freshModule({ stock: [TAPE] });
    await expect(m.priceLines([])).rejects.toThrow(/at least one line/i);
  });
});

describe('totalsFor — mixed VAT rates', () => {
  it('taxes each line at its own rate rather than the basket at one', async () => {
    const m = await freshModule({ stock: [TAPE, FLAPJACK] });
    const lines = await m.priceLines([
      { hhStockId: 25, qty: 1 },    // 7.50 + 1.50 VAT
      { hhStockId: 671, qty: 2 },   // 3.20 + 0.00 VAT
    ]);
    const t = m.totalsFor(lines);
    expect(t.net).toBe(10.7);
    expect(t.vat).toBe(1.5);        // NOT 2.14 — the flapjacks carry none
    expect(t.gross).toBe(12.2);
    expect(t.discount).toBe(0);
  });

  it('reports the discount as a share of the undiscounted total', async () => {
    const m = await freshModule({ stock: [TAPE] });
    const lines = await m.priceLines([{ hhStockId: 25, qty: 2, unitPriceCharged: 6.75 }]);
    const t = m.totalsFor(lines);
    expect(t.discount).toBe(1.5);           // £15 list → £13.50 charged
    expect(t.discountPct).toBeCloseTo(10, 5);
  });
});

describe('maxDiscountPctForRole', () => {
  it('reads the configured ceilings', async () => {
    const m = await freshModule({ caps: '{"admin":100,"manager":50,"staff":10}' });
    await expect(m.maxDiscountPctForRole('admin')).resolves.toBe(100);
    await expect(m.maxDiscountPctForRole('staff')).resolves.toBe(10);
  });

  it('treats weekend_manager exactly as manager', async () => {
    // weekend_manager IS a manager everywhere else in the platform; listing it
    // separately is how roles drift apart.
    const m = await freshModule({ caps: '{"manager":50}' });
    await expect(m.maxDiscountPctForRole('weekend_manager')).resolves.toBe(50);
  });

  it('gives an unknown role nothing — this one fails CLOSED', async () => {
    const m = await freshModule({ caps: '{"admin":100}' });
    await expect(m.maxDiscountPctForRole('some_new_role')).resolves.toBe(0);
    await expect(m.maxDiscountPctForRole(null)).resolves.toBe(0);
  });

  it('falls back to the built-in ceilings when the setting is missing', async () => {
    const m = await freshModule({ caps: null });
    await expect(m.maxDiscountPctForRole('staff')).resolves.toBe(10);
    await expect(m.maxDiscountPctForRole('admin')).resolves.toBe(100);
  });

  it('ignores a malformed setting rather than handing everyone an admin ceiling', async () => {
    const m = await freshModule({ caps: 'not json' });
    await expect(m.maxDiscountPctForRole('staff')).resolves.toBe(10);
  });

  it('freelancers may not discount at all', async () => {
    const m = await freshModule({ caps: null });
    await expect(m.maxDiscountPctForRole('freelancer')).resolves.toBe(0);
  });
});
