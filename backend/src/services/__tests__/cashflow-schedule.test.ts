import {
  addDays, addWorkingDays, dayInMonth, daysBetween, expandRule, isIsoDate, isoWeekday, mondayOf,
  nextDates, simulateCard, youlendPayoffEstimate, youlendWithholding, CardInput, cardSpendCheck,
} from '../cashflow-schedule';

describe('dates', () => {
  it('adds days across months and clocks changing', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');   // BST ends 25 Oct
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-11-02', '2026-11-16')).toBe(14);
  });

  it('knows the weekday and the Monday of a week', () => {
    expect(isoWeekday('2026-11-02')).toBe(1);  // Monday
    expect(isoWeekday('2026-11-08')).toBe(7);  // Sunday
    expect(mondayOf('2026-11-04')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
  });

  it('pulls a day back to the end of a short month', () => {
    expect(dayInMonth(2026, 11, 31)).toBe('2026-11-30');
    expect(dayInMonth(2027, 2, 30)).toBe('2027-02-28');
    expect(dayInMonth(2026, 14, 5)).toBe('2027-02-05');   // month past December
  });

  it('rejects things that are not dates', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate('2026-11-04')).toBe(true);
  });

  it('counts working days, skipping weekends and bank holidays', () => {
    expect(addWorkingDays('2026-11-06', 2)).toBe('2026-11-10');   // Fri → Tue
    expect(addWorkingDays('2026-11-07', 2)).toBe('2026-11-10');   // Sat → Tue
    expect(addWorkingDays('2026-12-24', 1)).toBe('2026-12-29');   // Christmas + Boxing Day (Mon 28th in lieu)
    expect(addWorkingDays('2026-11-04', 0)).toBe('2026-11-04');
  });
});

describe('expandRule', () => {
  it('keeps the start day of the month, pulled back in short months', () => {
    expect(expandRule({ frequency: 'monthly', start: '2026-10-31' }, '2026-11-01', '2027-03-01'))
      .toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  });

  it('starts at `from` even when the rule started long ago', () => {
    expect(expandRule({ frequency: 'monthly', start: '2019-03-15' }, '2026-11-04', '2026-12-31'))
      .toEqual(['2026-11-15', '2026-12-15']);
    expect(expandRule({ frequency: 'weekly', start: '2020-01-06' }, '2026-11-04', '2026-11-20'))
      .toEqual(['2026-11-09', '2026-11-16']);
  });

  it('stops at the end date', () => {
    expect(expandRule({ frequency: 'monthly', start: '2026-11-01', end: '2027-01-15' }, '2026-11-01', '2027-06-01'))
      .toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });

  it('does quarterly, yearly and once', () => {
    expect(expandRule({ frequency: 'quarterly', start: '2026-01-07' }, '2026-11-01', '2027-08-01'))
      .toEqual(['2027-01-07', '2027-04-07', '2027-07-07']);
    expect(expandRule({ frequency: 'yearly', start: '2024-12-01' }, '2026-11-01', '2027-12-31'))
      .toEqual(['2026-12-01', '2027-12-01']);
    expect(expandRule({ frequency: 'once', start: '2026-12-01' }, '2026-11-01', '2027-01-01')).toEqual(['2026-12-01']);
    expect(expandRule({ frequency: 'once', start: '2026-10-01' }, '2026-11-01', '2027-01-01')).toEqual([]);
  });

  it('previews the next dates', () => {
    expect(nextDates({ frequency: 'monthly', start: '2026-01-22' }, '2026-11-04', 3))
      .toEqual(['2026-11-22', '2026-12-22', '2027-01-22']);
    expect(nextDates({ frequency: 'yearly', start: '2026-12-25' }, '2026-11-04', 3))
      .toEqual(['2026-12-25', '2027-12-25', '2028-12-25']);
  });
});

describe('simulateCard', () => {
  const base: CardInput = {
    monthlyRate: 0, statementDay: 3, paymentDay: 23, plan: 'full', minPct: null,
    fixedAmount: null, fixedEvery: null, fixedWeekday: null, typicalMonthlySpend: null,
    balance: 1000, balanceAsOf: '2026-11-04',
  };

  it('pays a charge card in full on its due day', () => {
    const sim = simulateCard(base, '2026-12-31');
    expect(sim.payments).toEqual([{ date: '2026-11-23', amount: 1000, note: 'statement balance in full' }]);
    expect(sim.interest).toEqual([]);
  });

  it('pays each month\'s spending in full once a typical spend is set', () => {
    const sim = simulateCard({ ...base, balance: 0, typicalMonthlySpend: 3650 }, '2027-01-31');
    // 3,650 a month = £120 a day; Dec statement on the 3rd covers 29 days of spend.
    expect(sim.payments.map((p) => p.date)).toEqual(['2026-12-23', '2027-01-23']);
    expect(sim.payments[0].amount).toBeCloseTo(29 * 120, 0);
  });

  it('pays a fixed amount weekly, adds interest on the statement day, and never tops up when the month covers the minimum', () => {
    const sim = simulateCard({
      ...base, monthlyRate: 0.0183, statementDay: 27, paymentDay: 3, plan: 'fixed', minPct: 10,
      fixedAmount: 1000, fixedEvery: 'week', fixedWeekday: 1, balance: 38899, balanceAsOf: '2026-11-03',
    }, '2026-12-07');
    expect(sim.payments.every((p) => p.amount === 1000)).toBe(true);
    expect(sim.payments.map((p) => p.date)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']);
    expect(sim.interest).toHaveLength(1);
    expect(sim.interest[0].date).toBe('2026-11-27');
    expect(sim.interest[0].amount).toBeCloseTo((38899 - 3000) * 0.0183, 1);
  });

  it('tops up a fixed plan that falls short of the minimum, once a statement is known', () => {
    const sim = simulateCard({
      ...base, statementDay: 27, paymentDay: 3, plan: 'fixed', minPct: 10,
      fixedAmount: 100, fixedEvery: 'month', balance: 20000, balanceAsOf: '2026-11-01',
    }, '2026-12-05');
    // 3 Nov: before any statement — payments before the check-in are unknown, so no top-up.
    expect(sim.payments.filter((p) => p.date === '2026-11-03')).toEqual([{ date: '2026-11-03', amount: 100, note: 'monthly payment' }]);
    // 3 Dec: £100 + top-up to 10% of the 27 Nov statement (19,900) = £1,990 in all.
    const dec3 = sim.payments.filter((p) => p.date === '2026-12-03');
    expect(dec3.reduce((s, p) => s + p.amount, 0)).toBeCloseTo(1990, 2);
  });

  it('adds typical spend only after spendFrom, so receipts already logged aren\'t counted twice', () => {
    const sim = simulateCard({ ...base, balance: 1000, balanceAsOf: '2026-11-02', typicalMonthlySpend: 3650, spendFrom: '2026-11-04' }, '2026-11-06');
    // 2 Nov check-in, today 4 Nov: only 5 and 6 Nov accrue £120 each.
    expect(sim.balances.map((b) => b.balance)).toEqual([1000, 1000, 1120, 1240]);
  });

  it('never pays more than is owed', () => {
    const sim = simulateCard({ ...base, plan: 'fixed', fixedAmount: 600, fixedEvery: 'week', fixedWeekday: 1 }, '2026-11-30');
    expect(sim.payments.reduce((s, p) => s + p.amount, 0)).toBe(1000);
    expect(sim.balances[sim.balances.length - 1].balance).toBe(0);
  });
});

describe('YouLend', () => {
  it('keeps the rate of each receipt until the balance is paid', () => {
    const r = youlendWithholding(
      [{ date: '2026-11-10', amount: 1000 }, { date: '2026-11-10', amount: 500 }, { date: '2026-11-17', amount: 2000 }],
      0.28, 600,
    );
    expect(r.withheld).toEqual([{ date: '2026-11-10', amount: 420 }, { date: '2026-11-17', amount: 180 }]);
    expect(r.remainingAtEnd).toBe(0);
    expect(r.paidOffOn).toBe('2026-11-17');
  });

  it('estimates a payoff past the forecast', () => {
    expect(youlendPayoffEstimate(28000, 0.28, 10000, '2027-01-31')).toBe('2027-04-11');  // 10 weeks
    expect(youlendPayoffEstimate(0, 0.28, 10000, '2027-01-31')).toBeNull();
    expect(youlendPayoffEstimate(1000, 0.28, 0, '2027-01-31')).toBeNull();
  });
});

describe('cardSpendCheck', () => {
  const cot = {
    monthlyRate: 0, statementDay: 27, paymentDay: 3, plan: 'fixed' as const, minPct: 10,
    fixedAmount: 1000, fixedEvery: 'week' as const, fixedWeekday: 1,
  };

  it('needs two check-ins a week apart', () => {
    expect(cardSpendCheck(cot, [{ date: '2026-11-02', balance: 38899 }], [])).toBeNull();
    expect(cardSpendCheck(cot, [{ date: '2026-11-02', balance: 38899 }, { date: '2026-11-05', balance: 39000 }], [])).toBeNull();
  });

  it('works out the spend from the balance and the plan, and how much the receipts explain', () => {
    // 2 Nov → 30 Nov: four £1,000 Mondays (9, 16, 23, 30), no interest; balance went up £400.
    const c = cardSpendCheck(cot, [{ date: '2026-11-02', balance: 38899 }, { date: '2026-11-16', balance: 38500 }, { date: '2026-11-30', balance: 39299 }],
      [{ date: '2026-11-02', amount: 999 }, { date: '2026-11-10', amount: 2600 }, { date: '2026-11-25', amount: 500 }]);
    expect(c).toMatchObject({ from: '2026-11-02', to: '2026-11-30', checkIns: 3, assumedPayments: 4000, interest: 0, spent: 4400, receipts: 3100 });
    expect(c?.explained).toBeCloseTo(0.7, 2);
  });
});
