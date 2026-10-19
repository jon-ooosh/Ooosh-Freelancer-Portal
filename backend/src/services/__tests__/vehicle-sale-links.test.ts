/**
 * What leaves OP on a buyer's link (docs/VEHICLE-SALES-SPEC.md §6.3):
 * a switched-off section is never SENT, not just hidden, and the mileage
 * history never shows a reading that was later corrected.
 */
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn(async () => null) }));

import { shapeForBuyer, monthlyMileage, cleanSwitches, DEFAULT_SWITCHES, type FullSaleData } from '../vehicle-sale-links';

const full: FullSaleData = {
  reg: 'RX21ABC', make: 'MERCEDES-BENZ', model: 'SPRINTER', colour: 'SILVER', seats: 9,
  fuelType: 'diesel', gearbox: 'Automatic', bodyType: 'MINIBUS', v5Type: '907', vehicleCategory: 'M1',
  vin: 'WDB9076331P000001', dateFirstReg: '2021-03-01', maxMassKg: 3500, engineCc: 2143,
  currentMileage: 88000, motDue: '2027-02-26', taxDue: '2027-03-01', lastServiceDate: '2026-08-01',
  ulezCompliant: true, description: 'Tidy', askingPrice: 21000, vatBasis: 'plus',
  photos: [{ url: 'https://pub.example/events/e/RX21ABC/front.jpg', label: 'Front' }],
  service: [{ date: '2026-08-01', mileage: 85000, type: 'Service', description: 'B service', garage: 'Rossetts' }],
  mot: { fetchedAt: null, hasOutstandingRecall: 'No', tests: [] },
  mileage: [{ month: '2026-08', mileage: 85000 }],
  damage: [{ date: '2026-07-01', summary: 'Scuff NSF bumper', status: 'Repaired' }],
  contact: 'Jon — 01273 000000',
};

describe('shapeForBuyer', () => {
  it('sends the switched-on sections', () => {
    const p = shapeForBuyer(full, DEFAULT_SWITCHES);
    expect(p.price).toEqual({ amount: 21000, vatBasis: 'plus' });
    expect(p.serviceHistory).toHaveLength(1);
    expect(p.motHistory).toBeTruthy();
    expect(p.damageHistory).toHaveLength(1);
    expect(p.title).toBe('MERCEDES-BENZ SPRINTER');
    expect(p.vehicle.year).toBe(2021);
  });

  it('never sends a switched-off section — the key is absent, not empty', () => {
    const p = shapeForBuyer(full, {
      showPrice: false, showServiceHistory: false, showMotHistory: false,
      showMileageHistory: false, showDamageHistory: false,
    });
    for (const k of ['price', 'serviceHistory', 'motHistory', 'mileageHistory', 'damageHistory']) {
      expect(Object.prototype.hasOwnProperty.call(p, k)).toBe(false);
    }
    expect(JSON.stringify(p)).not.toContain('21000');
    expect(JSON.stringify(p)).not.toContain('Scuff');
  });

  it('mileage history is off by default', () => {
    expect('mileageHistory' in shapeForBuyer(full, DEFAULT_SWITCHES)).toBe(false);
  });

  it('builds from an allow-list — extra fields on the input never reach the buyer', () => {
    const leaky = { ...full, cashPrice: 30000, financeWith: 'Close Brothers', notes: 'internal' } as unknown as FullSaleData;
    const s = JSON.stringify(shapeForBuyer(leaky, { ...DEFAULT_SWITCHES, showMileageHistory: true }));
    expect(s).not.toContain('30000');
    expect(s).not.toContain('Close Brothers');
    expect(s).not.toContain('internal');
  });

  it('shows no price when none is set, even with the switch on', () => {
    expect('price' in shapeForBuyer({ ...full, askingPrice: null }, DEFAULT_SWITCHES)).toBe(false);
  });
});

describe('monthlyMileage', () => {
  it("keeps each month's last reading, oldest first", () => {
    expect(monthlyMileage([
      { recordedAt: '2026-07-02T10:00:00Z', mileage: 80000 },
      { recordedAt: '2026-07-28T10:00:00Z', mileage: 81500 },
      { recordedAt: '2026-08-15T10:00:00Z', mileage: 84000 },
    ], 84000)).toEqual([{ month: '2026-07', mileage: 81500 }, { month: '2026-08', mileage: 84000 }]);
  });

  it('drops a fat-fingered reading above the current mileage', () => {
    // RX73TBZ: a stuck-high reading in the log that was later corrected.
    expect(monthlyMileage([
      { recordedAt: '2026-07-10T10:00:00Z', mileage: 818000 },
      { recordedAt: '2026-08-10T10:00:00Z', mileage: 82000 },
    ], 82000)).toEqual([{ month: '2026-08', mileage: 82000 }]);
  });

  it('drops a month higher than a later one — odometers do not go down', () => {
    expect(monthlyMileage([
      { recordedAt: '2026-06-10T10:00:00Z', mileage: 79000 },
      { recordedAt: '2026-07-10T10:00:00Z', mileage: 90000 },
      { recordedAt: '2026-08-10T10:00:00Z', mileage: 82000 },
    ], null)).toEqual([{ month: '2026-06', mileage: 79000 }, { month: '2026-08', mileage: 82000 }]);
  });

  it('ignores junk', () => {
    expect(monthlyMileage([{ recordedAt: 'nope', mileage: 5 }, { recordedAt: '2026-01-01T00:00:00Z', mileage: 0 }], null)).toEqual([]);
  });
});

describe('cleanSwitches', () => {
  it('passes real booleans for known switches only', () => {
    expect(cleanSwitches({ showPrice: false, showMileageHistory: 'yes', hackerField: true }))
      .toEqual({ showPrice: false });
    expect(cleanSwitches(null)).toEqual({});
  });
});
