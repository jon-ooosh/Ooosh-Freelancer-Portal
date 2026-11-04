import { bookingChance, buildFixList, enquiryCash, FixInput, MIN_SAMPLE } from '../cashflow-pipeline';
import { requiredDeposit } from '../deposit-rule';

const settings = { weightProvisional: 0.85, weightHot: 0.7, weightWarm: 0.4, weightCold: 0.15, weightUnset: 0.25 };

describe('requiredDeposit (THE rule)', () => {
  it('is 25% with a £100 floor, the full amount under £400', () => {
    expect(requiredDeposit(1000)).toBe(250);
    expect(requiredDeposit(400)).toBe(100);
    expect(requiredDeposit(399.99)).toBe(399.99);
    expect(requiredDeposit(0)).toBe(0);
  });
});

describe('bookingChance', () => {
  it('uses the Settings figure for provisional', () => {
    expect(bookingChance('provisional', 'cold', [], settings)).toEqual({ chance: 0.85, basis: 'provisional — 85% (Settings)', learned: false });
  });

  it('learns from history once there are enough decided enquiries', () => {
    const c = bookingChance('quoting', 'hot', [{ likelihood: 'hot', booked: 27, lost: 11 }], settings);
    expect(c.learned).toBe(true);
    expect(c.chance).toBeCloseTo(27 / 38, 5);
    expect(c.basis).toBe('hot — 71% of 38 like it booked');
  });

  it('falls back to Settings when history is thin, and says how thin', () => {
    const c = bookingChance('quoting', 'warm', [{ likelihood: 'warm', booked: 5, lost: MIN_SAMPLE - 6 }], settings);
    expect(c).toEqual({ chance: 0.4, basis: 'warm — 40% (Settings; only 19 to learn from)', learned: false });
  });

  it('treats no likelihood as its own bucket', () => {
    const c = bookingChance('new_enquiry', null, [{ likelihood: 'unset', booked: 30, lost: 70 }], settings);
    expect(c.chance).toBeCloseTo(0.3, 5);
    expect(c.basis).toMatch(/^no likelihood set/);
  });
});

describe('enquiryCash', () => {
  it('puts the deposit a week after the next chase and the rest on the first day', () => {
    expect(enquiryCash({ start: '2026-12-20', nextChase: '2026-11-06', valueIncVat: 2000, depositsPaid: 0 }, '2026-11-04'))
      .toEqual({ depositDate: '2026-11-13', deposit: 500, balanceDate: '2026-12-20', balance: 1500 });
  });

  it('brings the deposit forward to a week before a hire that starts soon', () => {
    const c = enquiryCash({ start: '2026-11-15', nextChase: '2026-11-20', valueIncVat: 2000, depositsPaid: 0 }, '2026-11-04');
    expect(c.depositDate).toBe('2026-11-08');
  });

  it('never puts money in the past, and takes off what is already paid', () => {
    // £600 paid covers the £500 deposit: nothing more until the balance.
    const c = enquiryCash({ start: '2026-11-06', nextChase: null, valueIncVat: 2000, depositsPaid: 600 }, '2026-11-04');
    expect(c).toEqual({ depositDate: null, deposit: 0, balanceDate: '2026-11-06', balance: 1400 });
    // £300 paid leaves £200 of the deposit, due tomorrow at the latest.
    const p = enquiryCash({ start: '2026-11-06', nextChase: null, valueIncVat: 2000, depositsPaid: 300 }, '2026-11-04');
    expect(p).toEqual({ depositDate: '2026-11-05', deposit: 200, balanceDate: '2026-11-06', balance: 1500 });
    const d = enquiryCash({ start: '2026-11-08', nextChase: null, valueIncVat: 350, depositsPaid: 0 }, '2026-11-04');
    expect(d.depositDate).toBe('2026-11-05');   // a week before the start is already past → tomorrow
    expect(d.deposit).toBe(350);                // under £400: the full amount
    expect(d.balance).toBe(0);
  });
});

describe('buildFixList', () => {
  const base: FixInput = {
    dip: { start: '2027-01-04', end: '2027-01-10', closing: -7598 },
    target: 0,
    overdueBalances: [{ id: 'a', label: '#16702 Northbound', amount: 2800, jobId: 'j1' }, { id: 'b', label: '#16655 Kestrel', amount: 1320, jobId: 'j2' }],
    hireBalances: [
      { date: '2027-01-13', dueBy: '2027-01-11', label: '#16858', amount: 3000, jobId: 'j3' },
      { date: '2027-01-30', dueBy: '2027-01-28', label: '#16999', amount: 9000, jobId: 'j4' },   // too late to help
      { date: '2027-01-07', dueBy: '2027-01-05', label: '#16790', amount: 1860, jobId: 'j5' },   // already in the dip
    ],
    enquiries: [
      { jobId: 'e1', label: '#16851', start: '2027-01-20', chance: 0.71, deposit: 1000, basis: 'hot' },
      { jobId: 'e2', label: '#16862', start: '2027-01-15', chance: 0.42, deposit: 2000, basis: 'warm' },
      { jobId: 'e3', label: '#16900', start: '2027-03-01', chance: 0.9, deposit: 5000, basis: 'hot' },  // too far out
    ],
    bills: [{ id: 'x1', date: '2027-01-06', label: 'Supplier A', amount: 1200 }, { id: 'x2', date: '2027-01-20', label: 'B', amount: 99 }],
    cards: [{ name: 'Capital on Tap', headroom: 6101 }, { name: 'Amex', headroom: null }],
    bankTransfer: { on: true, keep: 450 },
  };

  it('lists nothing when no week dips below the target', () => {
    expect(buildFixList({ ...base, dip: null })).toEqual([]);
  });

  it('gives the actions, biggest first, with card headroom last as information', () => {
    const list = buildFixList(base);
    expect(list.map((a) => a.key)).toEqual(['chase_overdue', 'ask_early', 'nudge_enquiries', 'move_bills', 'bank_transfer', 'card_headroom']);
    expect(list.find((a) => a.key === 'chase_overdue')?.amount).toBe(4120);
    expect(list.find((a) => a.key === 'ask_early')?.amount).toBe(3000);
    const nudge = list.find((a) => a.key === 'nudge_enquiries')!;
    expect(nudge.amount).toBe(3000);
    expect(nudge.links.map((l) => l.jobId)).toEqual(['e2', 'e1']);   // 2000×0.42 = 840 beats 1000×0.71 = 710
    expect(list.find((a) => a.key === 'move_bills')?.amount).toBe(1200);
    expect(list[list.length - 1]).toMatchObject({ key: 'card_headroom', amount: null, detail: 'Capital on Tap: £6,101 free' });
  });

  it('leaves out bank transfer when it is switched off', () => {
    expect(buildFixList({ ...base, bankTransfer: { on: false, keep: 450 } }).some((a) => a.key === 'bank_transfer')).toBe(false);
  });
});
