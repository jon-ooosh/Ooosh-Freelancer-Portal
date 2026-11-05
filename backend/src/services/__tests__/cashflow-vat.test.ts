import {
  isFiled, normaliseEndMonth, onOrNextWorkingDay, previousQuarter, projectQuarterVat, quarterLabel, quarterToType, vatQuarterOf,
} from '../cashflow-vat';

// jon's set-up: quarters end Mar/Jun/Sep/Dec, paid on the 10th of the second month after.
const EM = 3;
const DAY = 10;

describe('vatQuarterOf', () => {
  it('finds the quarter in progress and its direct debit date', () => {
    const q = vatQuarterOf('2026-11-05', EM, DAY);
    expect(q).toEqual({ start: '2026-10-01', end: '2026-12-31', due: '2027-02-10' });
    expect(quarterLabel(q)).toBe('Oct–Dec 2026');
  });

  it('the quarter jon is filing now is due 10 Nov', () => {
    const prev = previousQuarter(vatQuarterOf('2026-11-05', EM, DAY), EM, DAY);
    expect(prev).toEqual({ start: '2026-07-01', end: '2026-09-30', due: '2026-11-10' });
  });

  it('a quarter-end day belongs to the quarter it ends', () => {
    expect(vatQuarterOf('2026-09-30', EM, DAY).end).toBe('2026-09-30');
    expect(vatQuarterOf('2026-10-01', EM, DAY).start).toBe('2026-10-01');
  });

  it('moves a weekend payment day to the next working day', () => {
    expect(onOrNextWorkingDay('2026-10-10')).toBe('2026-10-12');   // Saturday → Monday
    expect(vatQuarterOf('2028-11-15', EM, DAY).due).toBe('2029-02-12');   // 10 Feb 2029 is a Saturday
  });

  it('works for other quarter patterns', () => {
    expect(vatQuarterOf('2026-11-05', 1, DAY)).toEqual({ start: '2026-11-01', end: '2027-01-31', due: '2027-03-10' });
    expect(normaliseEndMonth(12)).toBe(3);
    expect(normaliseEndMonth(0)).toBe(3);
  });
});

describe('quarterToType', () => {
  it('asks for the quarter just ended until its return is in as a planned item', () => {
    expect(quarterToType('2026-11-05', EM, DAY, []).quarter.end).toBe('2026-09-30');
    expect(quarterToType('2026-11-05', EM, DAY, []).ended).toBe(true);
    expect(quarterToType('2026-11-05', EM, DAY, ['2026-11-10']).quarter.end).toBe('2026-12-31');
  });

  it('moves on once the payment date has passed', () => {
    expect(quarterToType('2026-11-11', EM, DAY, []).quarter.end).toBe('2026-12-31');
  });

  it('a planned VAT payment within ten days of the due date counts as filed', () => {
    const q = previousQuarter(vatQuarterOf('2026-11-05', EM, DAY), EM, DAY);
    expect(isFiled(q, ['2026-11-07'])).toBe(true);
    expect(isFiled(q, ['2026-12-10'])).toBe(false);
  });
});

describe('projectQuarterVat', () => {
  const q = vatQuarterOf('2026-11-05', EM, DAY);

  it('adds the rest of the quarter at the rate so far', () => {
    // 1 Oct to 5 Nov is 36 days; 56 still to come.
    expect(projectQuarterVat(6000, '2026-11-05', q)).toEqual({ amount: 15333.33, projected: 9333.33 });
  });

  it('adds nothing once the quarter has ended', () => {
    expect(projectQuarterVat(14000, '2027-01-04', q)).toEqual({ amount: 14000, projected: 0 });
  });

  it('never multiplies out a refund — six new vans are a one-off', () => {
    expect(projectQuarterVat(-40000, '2026-11-05', q)).toEqual({ amount: -40000, projected: 0 });
  });
});
