/**
 * Freelancer invoice due dates (jon, Oct 2026): the first Friday one week after
 * APPROVAL, i.e. 8 to 14 days after it; a Friday approval waits for the Friday
 * after next. Bills approved before the switch keep the old invoice-date rule,
 * because that date is already in Xero.
 */
jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../../routes/system-settings', () => ({ getSystemSetting: jest.fn() }));

import {
  freelancerDueDate, freelancerDueDateFromApproval, resolveDueDate, DEFAULT_TERMS,
} from '../supplier-terms';

// The week of Mon 26 Oct 2026 (GMT, after the clocks go back on the 25th).
const DAYS: Array<[string, string, number]> = [
  // approval day, due Friday, days later
  ['2026-10-26', '2026-11-06', 11], // Mon
  ['2026-10-27', '2026-11-06', 10], // Tue
  ['2026-10-28', '2026-11-06', 9],  // Wed
  ['2026-10-29', '2026-11-06', 8],  // Thu
  ['2026-10-30', '2026-11-13', 14], // Fri: the Friday after next
  ['2026-10-31', '2026-11-13', 13], // Sat
  ['2026-11-01', '2026-11-13', 12], // Sun
];

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

describe('freelancerDueDateFromApproval', () => {
  it.each(DAYS)('approved %s is due %s (%i days)', (approved, due, gap) => {
    expect(freelancerDueDateFromApproval(approved)).toBe(due);
    expect(daysBetween(approved, due)).toBe(gap);
  });

  it('always lands on a Friday 8 to 14 days later, across a year', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 366; i++) {
      const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const due = freelancerDueDateFromApproval(day)!;
      expect(new Date(`${due}T00:00:00Z`).getUTCDay()).toBe(5);
      const gap = daysBetween(day, due);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(gap).toBeLessThanOrEqual(14);
    }
  });

  it('is null with no date or a bad one', () => {
    expect(freelancerDueDateFromApproval(null)).toBeNull();
    expect(freelancerDueDateFromApproval('not-a-date')).toBeNull();
  });
});

describe('resolveDueDate for a freelancer invoice', () => {
  const SWITCH = new Date('2026-10-22T10:00:00Z');
  const base = { cost_type: 'freelancer_invoice', cost_date: '2026-10-01' };

  it('uses the approval day once approved after the switch', () => {
    const r = resolveDueDate({ ...base, approved_at: new Date('2026-10-29T15:00:00Z') }, DEFAULT_TERMS, SWITCH);
    expect(r.dueDate).toBe('2026-11-06');
    expect(r.terms.source).toBe('freelancer');
  });

  it('takes the UK day of the approval, not the UTC one', () => {
    // 00:30 on Fri 23 Oct in London (BST) is still Thursday in UTC.
    const r = resolveDueDate({ ...base, approved_at: new Date('2026-10-22T23:30:00Z') }, DEFAULT_TERMS, SWITCH);
    expect(r.dueDate).toBe(freelancerDueDateFromApproval('2026-10-23'));
    expect(r.dueDate).toBe('2026-11-06');
  });

  it('keeps the old invoice-date rule for a bill approved before the switch', () => {
    const r = resolveDueDate({ ...base, approved_at: new Date('2026-10-20T09:00:00Z') }, DEFAULT_TERMS, SWITCH);
    expect(r.dueDate).toBe(freelancerDueDate('2026-10-01'));
    expect(r.dueDate).toBe('2026-10-09');
  });

  it('keeps the old rule for everything when the switch is not recorded', () => {
    const r = resolveDueDate({ ...base, approved_at: new Date('2026-10-29T15:00:00Z') }, DEFAULT_TERMS, null);
    expect(r.dueDate).toBe('2026-10-09');
    const unapproved = resolveDueDate({ ...base, approved_at: null }, DEFAULT_TERMS);
    expect(unapproved.dueDate).toBe('2026-10-09');
  });

  it('shows a not-yet-approved bill as if approved today', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-28T12:00:00Z')); // Wed
    try {
      const r = resolveDueDate({ ...base, approved_at: null }, DEFAULT_TERMS, SWITCH);
      expect(r.dueDate).toBe('2026-11-06');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a staff override still wins', () => {
    const r = resolveDueDate(
      { ...base, approved_at: new Date('2026-10-29T15:00:00Z'), due_date_override: '2026-11-20' },
      DEFAULT_TERMS, SWITCH,
    );
    expect(r.dueDate).toBe('2026-11-20');
    expect(r.derivedDueDate).toBe('2026-11-06');
    expect(r.isOverride).toBe(true);
  });

  it('leaves other suppliers on their own terms', () => {
    const r = resolveDueDate({ cost_type: 'supplier_invoice', cost_date: '2026-10-01', approved_at: null }, DEFAULT_TERMS, SWITCH);
    expect(r.dueDate).toBe('2026-10-31');
  });
});
