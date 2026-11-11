/**
 * planIdentityDecision — what a staff accept / reject / change of mind writes.
 *
 * Katje / job 16831 (Nov 2026): a paper licence iDenfy couldn't read, rejected,
 * photos re-sent, details typed in by hand — and still "ID Rejected", because a
 * decision couldn't be changed from the page, and her name stayed her email.
 */
import { planIdentityDecision, ageOn } from '../identity-review';

const TODAY = '2026-11-09';

const katjeRejected = {
  identity_check_status: 'rejected',
  full_name: 'katje_76@yahoo.com',
  date_of_birth: new Date(1976, 10, 29), // node-postgres: local midnight
  licence_number: 'NB694029',
  licence_issued_by: 'St.Kat.Waver',
  licence_issue_country: 'BE',
  idenfy_check_date: '2026-11-08',
  requires_referral: false,
  referral_status: null,
};

function plan(over: Partial<Parameters<typeof planIdentityDecision>[0]>) {
  return planIdentityDecision({
    current: katjeRejected, outcome: 'accepted', notes: 'Photos re-supplied, checked',
    details: { full_name: 'Katje Example' }, isManager: true, today: TODAY, ...over,
  });
}

describe('planIdentityDecision', () => {
  it('a manager can reverse a rejection, and the name is written', () => {
    const p = plan({});
    expect(p).toEqual({ ok: true, set: { full_name: 'Katje Example' }, raisedReferral: null });
  });

  it('only a manager can reverse a rejection', () => {
    expect(plan({ isManager: false })).toMatchObject({ ok: false, status: 403 });
  });

  it('changing a decision needs a reason', () => {
    expect(plan({ notes: '  ' })).toMatchObject({ ok: false, status: 400, error: 'Say why the decision is changing.' });
    // …a first decision doesn't
    const first = plan({ current: { ...katjeRejected, identity_check_status: 'needs_review' }, notes: '' });
    expect(first.ok).toBe(true);
  });

  it('a name that is still the email address is not a name', () => {
    const p = plan({ details: {} });
    expect(p).toMatchObject({ ok: false, error: 'Fill in the full name before accepting.' });
  });

  it('lists everything missing', () => {
    const p = plan({ current: { identity_check_status: 'needs_review' }, details: {} });
    expect(p).toMatchObject({ ok: false });
    if (!p.ok) {
      expect(p.error).toContain('full name, date of birth, licence number, issued by, country of issue, date you checked the documents');
    }
  });

  it('never assumes a check date — it must be on the record or typed', () => {
    const p = plan({ current: { ...katjeRejected, idenfy_check_date: null } });
    expect(p).toMatchObject({ ok: false });
    if (!p.ok) expect(p.error).toContain('date you checked the documents');
    expect(plan({ current: { ...katjeRejected, idenfy_check_date: null },
      details: { full_name: 'K E', idenfy_check_date: '2026-11-10' } }))
      .toMatchObject({ ok: false, error: expect.stringContaining('future') });
  });

  it('writes the typed details and ticks a full licence', () => {
    const p = plan({ details: { full_name: ' Katje E ', nationality: 'Belgian', licence_valid_to: '2033-01-19', full_licence: true, licence_number: '' } });
    expect(p).toEqual({ ok: true, raisedReferral: null, set: {
      full_name: 'Katje E', nationality: 'Belgian', licence_valid_to: '2033-01-19', licence_type: 'full',
    } });
  });

  it('refuses a provisional licence and a bad date', () => {
    expect(plan({ current: { ...katjeRejected, licence_type: 'provisional' } })).toMatchObject({ ok: false });
    expect(plan({ details: { full_name: 'K', date_of_birth: '1976-13-45x' } })).toMatchObject({ ok: false });
  });

  it('under 23 is refused, as the webhook does', () => {
    const p = plan({ details: { full_name: 'K', date_of_birth: '2004-11-10' } });
    expect(p).toMatchObject({ ok: false, error: expect.stringContaining('under 23') });
    expect(plan({ details: { full_name: 'K', date_of_birth: '2003-11-09' } }).ok).toBe(true);
  });

  it('over 75 raises a referral, as the webhook does — never lowers one', () => {
    const p = plan({ details: { full_name: 'K', date_of_birth: '1950-01-01' } });
    expect(p).toMatchObject({ ok: true, raisedReferral: 'Driver is 76 years old (over 75)' });
    if (p.ok) expect(p.set).toMatchObject({ requires_referral: true, referral_notes: 'Driver is 76 years old (over 75)' });
    const approved = plan({ current: { ...katjeRejected, referral_status: 'approved' }, details: { full_name: 'K', date_of_birth: '1950-01-01' } });
    expect(approved).toMatchObject({ ok: true, raisedReferral: null });
  });

  it('rejecting writes no details', () => {
    expect(plan({ current: { ...katjeRejected, identity_check_status: 'needs_review' }, outcome: 'rejected', notes: '' }))
      .toEqual({ ok: true, set: {}, raisedReferral: null });
    // un-accepting needs a reason but not a manager
    expect(plan({ current: { ...katjeRejected, identity_check_status: 'accepted' }, outcome: 'rejected', isManager: false, notes: 'Fake' }).ok).toBe(true);
  });
});

describe('ageOn', () => {
  it('counts birthdays', () => {
    expect(ageOn('1976-11-29', '2026-11-09')).toBe(49);
    expect(ageOn('1976-11-09', '2026-11-09')).toBe(50);
  });
});
