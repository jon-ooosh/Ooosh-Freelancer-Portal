import { depreciate, rateForYear, basePrice, estimateVehicleValue, DEFAULT_CURVE } from '../vehicle-value';

jest.mock('../../routes/system-settings', () => ({
  getSystemSettings: jest.fn(async () => ({})),
}));

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('vehicle-value', () => {
  it('rate falls one point a year from 17% and stops at the 5% floor', () => {
    expect(rateForYear(0, DEFAULT_CURVE)).toBeCloseTo(0.17);
    expect(rateForYear(1, DEFAULT_CURVE)).toBeCloseTo(0.16);
    expect(rateForYear(2, DEFAULT_CURVE)).toBeCloseTo(0.15);
    expect(rateForYear(12, DEFAULT_CURVE)).toBeCloseTo(0.05);
    expect(rateForYear(30, DEFAULT_CURVE)).toBeCloseTo(0.05);
  });

  it('drops 10% on day one', () => {
    expect(depreciate(10000, d('2026-01-01'), d('2026-01-01'), DEFAULT_CURVE)).toBeCloseTo(9000);
  });

  it('applies whole years in turn', () => {
    // 10000 × 0.9 × 0.83 × 0.84 — two whole years (365.25-day years).
    const twoYears = new Date(d('2024-01-01').getTime() + 2 * 365.25 * 86400000);
    expect(depreciate(10000, d('2024-01-01'), twoYears, DEFAULT_CURVE)).toBeCloseTo(10000 * 0.9 * 0.83 * 0.84, 5);
  });

  it('compounds a part-year pro rata', () => {
    const half = new Date(d('2025-01-01').getTime() + 0.5 * 365.25 * 86400000);
    expect(depreciate(10000, d('2025-01-01'), half, DEFAULT_CURVE)).toBeCloseTo(9000 * Math.sqrt(0.83), 5);
  });

  it('a future start date only applies the day-one drop', () => {
    expect(depreciate(10000, d('2030-01-01'), d('2026-01-01'), DEFAULT_CURVE)).toBeCloseTo(9000);
  });

  it('rejects unusable inputs', () => {
    expect(depreciate(0, d('2025-01-01'), d('2026-01-01'), DEFAULT_CURVE)).toBeNull();
    expect(depreciate(10000, new Date('nope'), d('2026-01-01'), DEFAULT_CURVE)).toBeNull();
  });

  it('base price prefers cash price, else deposit + financed', () => {
    expect(basePrice({ cash_price: '42000.00', deposit_paid: 5000, amount_financed: 30000 })).toBe(42000);
    expect(basePrice({ cash_price: null, deposit_paid: '5000', amount_financed: '30000' })).toBe(35000);
    expect(basePrice({ cash_price: null, deposit_paid: null, amount_financed: null })).toBeNull();
  });

  it('estimate is ex-VAT and rounded by role', async () => {
    const row = { cash_price: 36000, date_first_reg: '2026-01-01' };
    const asOf = d('2026-01-01');
    // 36000 × 0.9 = 32400 inc VAT → 27000 ex VAT
    const admin = await estimateVehicleValue(row, { isAdmin: true, asOf, curve: DEFAULT_CURVE });
    expect(admin).toEqual({ value_ex_vat: 27000, rounded_to: 100, start_date: '2026-01-01' });
    const staff = await estimateVehicleValue({ cash_price: 36100, date_first_reg: '2026-01-01' }, { isAdmin: false, asOf, curve: DEFAULT_CURVE });
    expect(staff?.value_ex_vat).toBe(27000); // 27075 → nearest 500
    expect(staff?.rounded_to).toBe(500);
  });

  it('no estimate without a price or a first-registration date', async () => {
    expect(await estimateVehicleValue({ cash_price: 36000 }, { isAdmin: true, curve: DEFAULT_CURVE })).toBeNull();
    expect(await estimateVehicleValue({ date_first_reg: '2024-01-01' }, { isAdmin: true, curve: DEFAULT_CURVE })).toBeNull();
  });
});
