// The pure rules of Jon's review request email (docs/BUSINESS-FIGURES-SPEC.md §8c).
jest.mock('../../config/database', () => ({ query: jest.fn() }));
jest.mock('../email-service', () => ({ emailService: { send: jest.fn() } }));
jest.mock('../money-emails', () => ({ resolveClientEmailTarget: jest.fn() }));

import { daysAfterReturn, mailingListUrl, reviewDecision, reviewSubject, emailFromStopToken, stopUrl, MAX_DAYS_AFTER_RETURN } from '../review-requests';

const ok = { completedOn: '2026-11-12', returnedOn: '2026-11-10', isInternal: false, email: 'sam@band.com', optedOut: false, askedRecently: false };

describe('reviewSubject', () => {
  it('uses the name, or no name at all — never a placeholder', () => {
    expect(reviewSubject('Sam')).toBe('How did it go, Sam?');
    expect(reviewSubject('')).toBe('How did it go?');
    expect(reviewSubject('  ')).toBe('How did it go?');
  });
});

describe('mailingListUrl', () => {
  it('fills in email and names on the classic Mailchimp form', () => {
    const u = new URL(mailingListUrl('sam@band.com', 'Sam', "O'Neil"));
    expect(u.hostname).toBe('oooshtours.us17.list-manage.com');
    expect(u.searchParams.get('legacy_form')).toBe('1');
    expect(u.searchParams.get('MERGE0')).toBe('sam@band.com');
    expect(u.searchParams.get('MERGE1')).toBe('Sam');
    expect(u.searchParams.get('MERGE2')).toBe("O'Neil");
  });
  it('leaves out names it does not have', () => {
    const u = new URL(mailingListUrl('info@band.com', null, ''));
    expect(u.searchParams.get('MERGE0')).toBe('info@band.com');
    expect(u.searchParams.has('MERGE1')).toBe(false);
    expect(u.searchParams.has('MERGE2')).toBe(false);
  });
});

describe('daysAfterReturn', () => {
  it('counts whole UK days', () => {
    expect(daysAfterReturn('2026-11-01', '2026-11-11')).toBe(10);
    expect(daysAfterReturn('2026-10-25', '2026-10-26')).toBe(1); // across the clocks going back
    expect(daysAfterReturn(null, '2026-11-11')).toBeNull();
  });
});

describe('reviewDecision', () => {
  it('sends when everything is in order', () => {
    expect(reviewDecision(ok)).toEqual({ send: true });
  });
  it(`allows exactly ${MAX_DAYS_AFTER_RETURN} days, not one more`, () => {
    expect(reviewDecision({ ...ok, returnedOn: '2026-11-02' }).send).toBe(true);
    const d = reviewDecision({ ...ok, returnedOn: '2026-11-01' });
    expect(d.send).toBe(false);
    expect(!d.send && d.reason).toMatch(/11 days/);
  });
  it('gives a reason for every no', () => {
    const reasons = [
      reviewDecision({ ...ok, isInternal: true }),
      reviewDecision({ ...ok, returnedOn: null }),
      reviewDecision({ ...ok, email: null }),
      reviewDecision({ ...ok, optedOut: true }),
      reviewDecision({ ...ok, askedRecently: true }),
    ];
    for (const r of reasons) {
      expect(r.send).toBe(false);
      expect(!r.send && r.reason.length).toBeGreaterThan(5);
    }
  });
});

describe('stop links', () => {
  it('round-trip the address, lower-cased, and refuse anything else', () => {
    const url = new URL(stopUrl('Sam@Band.com'));
    expect(emailFromStopToken(url.searchParams.get('t')!)).toBe('sam@band.com');
    expect(emailFromStopToken('nonsense')).toBeNull();
  });
});
