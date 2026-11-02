/**
 * The pure rules of a van sale (docs/VEHICLE-SALES-SPEC.md D7):
 * who may change what, and which photos may be referenced.
 */
import {
  planSalePatch,
  cleanDate,
  cleanPrice,
  isEventPhotoKeyForVan,
  SaleError,
} from '../vehicle-sales';

function errorOf(fn: () => unknown): SaleError {
  try {
    fn();
  } catch (e) {
    return e as SaleError;
  }
  throw new Error('expected a SaleError');
}

describe('planSalePatch — staff', () => {
  it('lets any staff member move the stage and edit the description', () => {
    expect(planSalePatch({ status: 'listed', description: '  Tidy van  ' }, 'staff', 'preparing'))
      .toEqual({ status: 'listed', description: 'Tidy van' });
    expect(planSalePatch({ status: 'under_offer' }, 'general_assistant', 'listed'))
      .toEqual({ status: 'under_offer' });
  });

  it('clears an emptied description to NULL, not an empty string', () => {
    expect(planSalePatch({ description: '   ' }, 'staff', 'listed')).toEqual({ description: null });
  });

  it('keeps price, VAT and hold date for admins — managers included in the refusal', () => {
    for (const role of ['staff', 'manager', 'weekend_manager']) {
      expect(errorOf(() => planSalePatch({ askingPrice: 9000 }, role, 'listed')).status).toBe(403);
    }
    expect(errorOf(() => planSalePatch({ holdFromHire: '2026-11-01' }, 'staff', 'listed')).status).toBe(403);
  });

  it('only an admin can withdraw', () => {
    expect(errorOf(() => planSalePatch({ status: 'withdrawn' }, 'manager', 'listed')).status).toBe(403);
  });
});

describe('planSalePatch — admin', () => {
  it('sets price, VAT and hold date', () => {
    expect(planSalePatch({ askingPrice: '12500.50', vatBasis: 'inc', holdFromHire: '2026-11-14' }, 'admin', 'preparing'))
      .toEqual({ asking_price: 12500.5, price_vat_basis: 'inc', hold_from_hire: '2026-11-14' });
  });

  it('clears the hold date and price with null', () => {
    expect(planSalePatch({ holdFromHire: null, askingPrice: '' }, 'admin', 'listed'))
      .toEqual({ hold_from_hire: null, asking_price: null });
  });

  it('withdraws with a reason', () => {
    expect(planSalePatch({ status: 'withdrawn', closedReason: ' Keeping it ' }, 'admin', 'listed'))
      .toEqual({ status: 'withdrawn', closed_reason: 'Keeping it' });
  });
});

describe('planSalePatch — never', () => {
  it('never marks sold here — that is the sold modal', () => {
    expect(errorOf(() => planSalePatch({ status: 'sold' }, 'admin', 'under_offer')).status).toBe(400);
  });

  it('refuses any change to a closed sale', () => {
    expect(errorOf(() => planSalePatch({ description: 'x' }, 'admin', 'sold')).status).toBe(409);
    expect(errorOf(() => planSalePatch({ status: 'listed' }, 'admin', 'withdrawn')).status).toBe(409);
  });

  it('rejects an unknown stage and bad values', () => {
    expect(errorOf(() => planSalePatch({ status: 'on_ebay' }, 'staff', 'listed')).status).toBe(400);
    expect(errorOf(() => planSalePatch({ askingPrice: -5 }, 'admin', 'listed')).status).toBe(400);
    expect(errorOf(() => planSalePatch({ vatBasis: 'zero' }, 'admin', 'listed')).status).toBe(400);
    expect(errorOf(() => planSalePatch({ holdFromHire: '0006-08-25' }, 'admin', 'listed')).status).toBe(400);
  });
});

describe('cleanDate', () => {
  it('accepts a real date and rejects impossible ones', () => {
    expect(cleanDate('2026-02-28')).toBe('2026-02-28');
    expect(cleanDate('2026-02-30')).toBeUndefined();
    expect(cleanDate('26-02-28')).toBeUndefined();
    expect(cleanDate('')).toBeNull();
  });
});

describe('cleanPrice', () => {
  it('rounds to pence and rejects junk', () => {
    expect(cleanPrice('9999.999')).toBe(10000);
    expect(cleanPrice('abc')).toBeUndefined();
    expect(cleanPrice(null)).toBeNull();
  });
});

describe('isEventPhotoKeyForVan', () => {
  it('accepts this van’s walkaround and damage photos', () => {
    expect(isEventPhotoKeyForVan('events/abc-123/RX21ABC/front.jpg', 'RX21ABC')).toBe(true);
    expect(isEventPhotoKeyForVan('events/abc-123/RX21ABC/damage/9/0.jpg', 'rx21abc')).toBe(true);
  });

  it('handles a reg stored with a space', () => {
    expect(isEventPhotoKeyForVan('events/e1/RX21-ABC/rear.jpg', 'RX21 ABC')).toBe(true);
  });

  it('refuses another van, other folders and path tricks', () => {
    expect(isEventPhotoKeyForVan('events/abc/RX99ZZZ/front.jpg', 'RX21ABC')).toBe(false);
    expect(isEventPhotoKeyForVan('staff-records/x/RX21ABC/front.jpg', 'RX21ABC')).toBe(false);
    expect(isEventPhotoKeyForVan('events/abc/RX21ABC/../../staff-records/a.jpg', 'RX21ABC')).toBe(false);
    expect(isEventPhotoKeyForVan('events/abc/RX21ABC/report.pdf', 'RX21ABC')).toBe(false);
  });
});
