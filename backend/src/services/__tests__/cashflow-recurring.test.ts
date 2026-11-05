import { alreadyCountedAs, findRecurring, SpendTxn } from '../cashflow-recurring';

const TODAY = '2026-11-05';
const monthly = (name: string, day: number, amount: number, months = 12, id: string | null = `id-${name}`, jitter: number[] = []): SpendTxn[] =>
  Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10 - i, day));   // Nov 2026 back
    return { contactId: id, contactName: name, date: d.toISOString().slice(0, 10), amount: amount + (jitter[i] || 0) };
  }).filter((t) => t.date <= TODAY);

describe('findRecurring', () => {
  it('finds a steady monthly payment and when the next one falls', () => {
    const [s] = findRecurring(monthly('Landlord Ltd', 1, 4200), TODAY);
    expect(s).toMatchObject({ contactName: 'Landlord Ltd', frequency: 'monthly', amount: 4200, steady: true, day: 1, nextDate: '2026-12-01' });
    expect(s.count).toBe(12);
    expect(s.recent).toHaveLength(4);
  });

  it('offers a varying bill as "varies", and leaves out spending with no pattern in the amount', () => {
    const water = findRecurring(monthly('Southern Water', 20, 100, 12, 'w', [0, 25, -20, 30, -15, 10, 35, -25, 0, 20, -10, 15]), TODAY);
    expect(water[0]).toMatchObject({ frequency: 'monthly', steady: false, nextDate: '2026-11-20' });
    const fuel = findRecurring(monthly('Shell', 10, 100, 12, 's', [0, 300, -80, 450, 10, -70, 600, 0, 200, -60, 900, 40]), TODAY);
    expect(fuel).toEqual([]);
  });

  it('needs six months, about one payment a month, on about the same day, and still going', () => {
    expect(findRecurring(monthly('New Sub', 3, 50, 5), TODAY)).toEqual([]);
    const lapsed = monthly('Old Sub', 3, 50, 12).map((t) => ({ ...t, date: t.date.replace('2026-', '2025-') }));
    expect(findRecurring(lapsed, TODAY)).toEqual([]);
    const scattered: SpendTxn[] = [1, 9, 17, 25, 4, 28, 12, 21].map((day, i) => ({ contactId: 'x', contactName: 'Random', date: `2026-${String(3 + i).padStart(2, '0')}-${String(day).padStart(2, '0')}`, amount: 80 }));
    expect(findRecurring(scattered, TODAY)).toEqual([]);
  });

  it('finds a quarterly payment', () => {
    const q: SpendTxn[] = ['2026-01-28', '2026-04-27', '2026-07-28', '2026-10-27'].map((date) => ({ contactId: 'q', contactName: 'Rates', date, amount: 1450 }));
    const [s] = findRecurring(q, TODAY);
    expect(s).toMatchObject({ frequency: 'quarterly', amount: 1450, day: 28, nextDate: '2027-01-28' });   // usual day: 27.5 rounds to the 28th
  });

  it('groups by contact, or by name when Xero has no contact', () => {
    const named = monthly('Software Co Ltd', 15, 30, 12, null);
    expect(findRecurring(named, TODAY)[0].key).toBe('name:software co');
  });
});

describe('alreadyCountedAs', () => {
  it('spots card repayments and van HP lenders', () => {
    expect(alreadyCountedAs('Capital On Tap', [])).toBe('card');
    expect(alreadyCountedAs('American Express Services', [])).toBe('card');
    expect(alreadyCountedAs('Close Brothers Motor Finance', ['Close Brothers'])).toBe('van_hp');
    expect(alreadyCountedAs('Landlord Ltd', ['Close Brothers'])).toBeNull();
  });
});
