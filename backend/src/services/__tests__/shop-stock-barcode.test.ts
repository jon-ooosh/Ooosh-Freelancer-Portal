/**
 * Barcode matching for the shop till (scan → basket).
 *
 * A pack's barcode reaches the till as UPC-A (12 digits) or EAN-13 (the same
 * digits with a leading 0), depending on the scanner. HireHop holds whichever
 * was typed in. `barcodeKey()` must make those one code, or a scan says
 * "no item" for a pack that is on the shelf.
 */
export {};

jest.mock('../../config/database', () => ({ query: jest.fn(), getClient: jest.fn() }));

import { query } from '../../config/database';
import { barcodeKey, findShopStockByBarcode } from '../shop-stock';

const q = query as jest.Mock;

describe('barcodeKey', () => {
  it('makes UPC-A and its EAN-13 form the same code', () => {
    expect(barcodeKey('749699128328')).toBe('749699128328');
    expect(barcodeKey('0749699128328')).toBe('749699128328');
  });

  it('trims what a scanner or a paste adds around the code', () => {
    expect(barcodeKey('  749699128328\n')).toBe('749699128328');
  });

  it('gives nothing usable for blank or all-zero input', () => {
    expect(barcodeKey('')).toBe('');
    expect(barcodeKey('   ')).toBe('');
    expect(barcodeKey('0000')).toBe('');
    expect(barcodeKey(null)).toBe('');
    expect(barcodeKey(undefined)).toBe('');
  });
});

describe('findShopStockByBarcode', () => {
  beforeEach(() => q.mockReset());

  it('never asks the database for a blank code', async () => {
    await expect(findShopStockByBarcode('  ')).resolves.toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });

  it('looks up the zero-stripped code, sellable items only', async () => {
    q.mockResolvedValue({ rows: [] });
    await expect(findShopStockByBarcode('0749699128328')).resolves.toEqual([]);
    const [sql, params] = q.mock.calls[0];
    expect(params).toEqual(['749699128328']);
    expect(sql).toContain(`ltrim(btrim(barcode), '0') = $1`);
    expect(sql).toContain('status = 0');
  });
});

describe('searchShopStock — barcode in the type-ahead', () => {
  beforeEach(() => q.mockReset());

  /** First call reads the excluded categories, the second is the search. */
  async function searchSql(term: string) {
    const { searchShopStock } = await import('../shop-stock');
    q.mockResolvedValueOnce({ rows: [{ value: '[5]' }] }).mockResolvedValueOnce({ rows: [] });
    await searchShopStock(term);
    return q.mock.calls[1] as [string, unknown[]];
  }

  it('matches a one-word term against the whole barcode, ranked first', async () => {
    const [sql, params] = await searchSql('0749699128328');
    // $1 prefix, $2 rank, $3 limit, $4 the token, $5 the barcode, $6 categories
    expect(params[4]).toBe('749699128328');
    expect(params[5]).toEqual([5]);
    expect(sql).toContain(`OR ltrim(btrim(barcode), '0') = $5)`);
    expect(sql).toContain(`CASE WHEN ltrim(btrim(barcode), '0') = $5 THEN 0 ELSE 1 END`);
    expect(sql).toContain('= ANY($6::int[])');
  });

  it('leaves barcodes out of a several-word search', async () => {
    const [sql, params] = await searchSql('2 gaff');
    expect(sql).not.toContain('barcode');
    expect(params).toHaveLength(6);   // 3 fixed + 2 tokens + categories
  });
});
