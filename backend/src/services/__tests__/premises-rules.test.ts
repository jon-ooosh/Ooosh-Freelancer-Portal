import {
  canSee, visibleLevels, roleRank, checkStatus, reminderWanted, nextDueAfterRecord, reminderTitle,
} from '../premises-rules';

describe('premises — who can see a check', () => {
  it('everyone means every staff role, never a freelancer', () => {
    for (const r of ['admin', 'manager', 'weekend_manager', 'staff', 'general_assistant']) expect(canSee(r, 'all')).toBe(true);
    expect(canSee('freelancer', 'all')).toBe(false);
    expect(canSee(undefined, 'all')).toBe(false);
  });
  it('managers-only includes the weekend manager; admins-only is admins', () => {
    expect(canSee('weekend_manager', 'managers')).toBe(true);
    expect(canSee('staff', 'managers')).toBe(false);
    expect(canSee('manager', 'admins')).toBe(false);
    expect(canSee('admin', 'admins')).toBe(true);
  });
  it('lists the levels a role reaches, for SQL', () => {
    expect(visibleLevels('staff')).toEqual(['all']);
    expect(visibleLevels('manager')).toEqual(['all', 'managers']);
    expect(visibleLevels('admin')).toEqual(['all', 'managers', 'admins']);
    expect(visibleLevels('freelancer')).toEqual([]);
    expect(roleRank('nonsense')).toBe(-1);
  });
  it('an unknown visibility is never visible', () => {
    expect(canSee('admin', 'secret')).toBe(false);
  });
});

describe('premises — status', () => {
  const today = '2026-11-19';
  it('no date is not set up', () => expect(checkStatus(null, 30, today)).toBe('no_date'));
  it('past the date is overdue', () => expect(checkStatus('2026-11-18', 30, today)).toBe('overdue'));
  it('inside the lead is due soon, the day itself included', () => {
    expect(checkStatus('2026-12-19', 30, today)).toBe('due_soon');
    expect(checkStatus('2026-11-19', 0, today)).toBe('due_soon');
  });
  it('outside the lead is OK', () => {
    expect(checkStatus('2026-12-20', 30, today)).toBe('ok');
    expect(checkStatus('2026-11-20', 0, today)).toBe('ok');
  });
  it('the reminder is wanted inside the lead and when overdue', () => {
    expect(reminderWanted('2026-12-19', 30, today)).toBe(true);
    expect(reminderWanted('2026-10-01', 30, today)).toBe(true);
    expect(reminderWanted('2026-12-20', 30, today)).toBe(false);
    expect(reminderWanted(null, 30, today)).toBe(false);
  });
  it('counts across the clocks going back without slipping a day', () => {
    expect(checkStatus('2026-10-26', 1, '2026-10-25')).toBe('due_soon');
    expect(checkStatus('2026-10-27', 1, '2026-10-25')).toBe('ok');
  });
});

describe('premises — next due once done', () => {
  const yearly = { mode: 'after_done' as const, rule: { freq: 'year' as const, interval: 1 }, anchor: null };

  it('"every 12 months from the last one" counts from the day it was done', () => {
    expect(nextDueAfterRecord(yearly, '2026-12-14', '2026-12-14', null)).toEqual({ date: '2027-12-14', source: 'computed' });
    // Done a month late: the clock starts from when it was actually done.
    expect(nextDueAfterRecord(yearly, '2027-01-14', '2026-12-14', null).date).toBe('2028-01-14');
  });

  it('a date from the certificate wins over the rule', () => {
    const eicr = { mode: 'after_done' as const, rule: { freq: 'year' as const, interval: 5 }, anchor: null };
    expect(nextDueAfterRecord(eicr, '2026-03-03', null, '2029-03-03')).toEqual({ date: '2029-03-03', source: 'certificate' });
  });

  it('"every year on 1 Jan" stays on 1 Jan whenever it is done (the van prep pattern)', () => {
    const jan = { mode: 'schedule' as const, rule: { freq: 'year' as const, interval: 1 }, anchor: '2027-01-01' };
    expect(nextDueAfterRecord(jan, '2026-12-20', '2027-01-01', null).date).toBe('2028-01-01');
    expect(nextDueAfterRecord(jan, '2027-01-03', '2027-01-01', null).date).toBe('2028-01-01');
  });

  it('a weekly test done early does not land on the week it was due', () => {
    // Every Thursday (weekday 3), due Thu 19 Nov, done Tue 17 Nov → Thu 26 Nov.
    const weekly = { mode: 'schedule' as const, rule: { freq: 'week' as const, interval: 1, weekdays: [3] }, anchor: '2026-11-05' };
    expect(nextDueAfterRecord(weekly, '2026-11-17', '2026-11-19', null).date).toBe('2026-11-26');
    // Done late on Mon 23 Nov → Thu 26 Nov, not a backlog of missed weeks.
    expect(nextDueAfterRecord(weekly, '2026-11-23', '2026-11-19', null).date).toBe('2026-11-26');
  });

  it('a one-off with no certificate date has nothing further due', () => {
    expect(nextDueAfterRecord({ mode: null, rule: null, anchor: null }, '2026-11-19', '2026-11-19', null))
      .toEqual({ date: null, source: null });
  });
});

describe('premises — the To Do title', () => {
  it('says what to do and when', () => {
    expect(reminderTitle('visit', 'ours', 'Gas safety inspection', '2026-12-14')).toBe('Book: Gas safety inspection (due 14 Dec 2026)');
    expect(reminderTitle('renewal', 'ours', 'Public liability insurance', '2027-01-01')).toBe('Renew: Public liability insurance (due 1 Jan 2027)');
    expect(reminderTitle('test', 'ours', 'Fire alarm test', '2026-11-20')).toBe('Fire alarm test (due 20 Nov 2026)');
    expect(reminderTitle('visit', 'landlord', 'EICR', '2027-03-03')).toBe("Get the landlord's copy: EICR (due 3 Mar 2027)");
  });
});
